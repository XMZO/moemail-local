import { randomUUID } from "node:crypto"
import type {
  EffectiveAccessPolicy,
  MailDirection,
  MailQuotaAssignment,
  MailQuotaRule,
} from "./access-policies"
import {
  effectiveMailQuotaAssignments,
  isMigratedMailQuotaAssignment,
  isDomainOperationAllowed,
  resolveMailQuotaAssignments,
} from "./access-policies"
import {
  getDatabaseDriver,
  getPostgresPool,
  getSqlite,
} from "./db"
import {
  normalizeMailboxAddress,
  normalizeMailboxDomain,
} from "./email-address"
import { PERMISSIONS, ROLES, type Role } from "./permissions"
import { getUserAccessPolicy } from "./user-access"

const UNIT_MILLISECONDS = {
  second: 1_000,
  minute: 60_000,
  hour: 60 * 60_000,
  day: 24 * 60 * 60_000,
  week: 7 * 24 * 60 * 60_000,
  month: 30 * 24 * 60 * 60_000,
} as const

const RESERVATION_LEASE_MILLISECONDS = 5 * 60_000

export interface MailQuotaCounter {
  rule: MailQuotaRule
  completed: number
  pending: number
  used: number
  remaining: number | null
}

export type SendQuotaCounter = MailQuotaCounter & { sent: number }

export interface AppliedMailQuotaCounter {
  assignment: MailQuotaAssignment
  rolling: MailQuotaCounter
  lifetimeCompleted: number
  lifetimePending: number
  lifetimeUsed: number
  lifetimeRemaining: number | null
}

export interface MailQuotaSnapshot {
  direction: MailDirection
  subject: string
  role: Role
  applied: AppliedMailQuotaCounter[]
}

export interface SendQuotaSnapshot extends Omit<MailQuotaSnapshot, "applied"> {
  applied: Array<Omit<AppliedMailQuotaCounter, "rolling"> & { rolling: SendQuotaCounter }>
}

export interface MailQuotaUsage {
  direction: MailDirection
  target: { type: "all" | "role" | "user"; id: string }
  aggregate: boolean
  allTimeCompleted: number
  rules: AppliedMailQuotaCounter[]
}

export interface SendQuotaUsage extends Omit<MailQuotaUsage, "rules"> {
  allTimeSent: number
  rules: Array<Omit<AppliedMailQuotaCounter, "rolling"> & { rolling: SendQuotaCounter }>
}

export type MailQuotaError =
  | "SEND_PERMISSION_DENIED"
  | "RECEIVE_PERMISSION_DENIED"
  | "MAIL_DOMAIN_SEND_FORBIDDEN"
  | "MAIL_DOMAIN_RECEIVE_FORBIDDEN"
  | "SEND_GLOBAL_QUOTA_EXCEEDED"
  | "SEND_TOTAL_QUOTA_EXCEEDED"
  | "SEND_DOMAIN_QUOTA_EXCEEDED"
  | "SEND_MAILBOX_QUOTA_EXCEEDED"
  | "SEND_MAILBOX_LIFETIME_QUOTA_EXCEEDED"
  | "RECEIVE_GLOBAL_QUOTA_EXCEEDED"
  | "RECEIVE_TOTAL_QUOTA_EXCEEDED"
  | "RECEIVE_DOMAIN_QUOTA_EXCEEDED"
  | "RECEIVE_MAILBOX_QUOTA_EXCEEDED"
  | "RECEIVE_MAILBOX_LIFETIME_QUOTA_EXCEEDED"
  | "SEND_PERMISSION_CHECK_FAILED"
  | "RECEIVE_PERMISSION_CHECK_FAILED"

export interface MailPermissionResult {
  allowed: boolean
  error?: MailQuotaError
  quota?: MailQuotaSnapshot
  remaining?: number
}

export interface SendPermissionResult {
  canSend: boolean
  error?: MailQuotaError
  quota?: SendQuotaSnapshot
  remainingEmails?: number
}

export interface MailQuotaReservation {
  id: string
  direction: MailDirection
  userId: string
  subject: string
  domain: string
  mailboxAddress: string
  createdAt: Date
  expiresAt: Date
}

export type SendQuotaReservation = MailQuotaReservation

type RawCounter = {
  completed: number
  pending: number
  lifetimeCompleted: number
  lifetimePending: number
}

type MailQuotaSqlite = ReturnType<typeof getSqlite>
type Query = <T extends Record<string, unknown> = Record<string, string | number>>(
  text: string,
  values?: unknown[],
) => Promise<{ rows: T[] }>
type CounterFilter =
  | { column: "user_id" | "policy_role" | "quota_subject"; value: string }
  | { column: "all"; excludeEmperor: boolean }

let validationDatabaseOverride: MailQuotaSqlite | undefined

export function setSendQuotaDatabaseForValidation(database?: MailQuotaSqlite) {
  if (process.env.NODE_ENV === "production") throw new Error("VALIDATION_OVERRIDE_FORBIDDEN")
  validationDatabaseOverride = database
}

export const setMailQuotaDatabaseForValidation = setSendQuotaDatabaseForValidation

function sqliteHandle() {
  return validationDatabaseOverride ?? getSqlite()
}

function activeDriver() {
  return validationDatabaseOverride ? "sqlite" : getDatabaseDriver()
}

function quotaSubject(userId: string) {
  return `user:${userId}`
}

function minimumRemaining(applied: AppliedMailQuotaCounter[]) {
  const finite = applied.flatMap(item => [
    ...(item.rolling.remaining === null ? [] : [item.rolling.remaining]),
    ...(item.lifetimeRemaining === null ? [] : [item.lifetimeRemaining]),
  ])
  return finite.length === 0 ? undefined : Math.min(...finite)
}

export function mailQuotaWindowMilliseconds(rule: MailQuotaRule) {
  const duration = rule.windowValue * UNIT_MILLISECONDS[rule.windowUnit]
  return Number.isSafeInteger(duration) ? duration : Number.MAX_SAFE_INTEGER
}

export const sendQuotaWindowMilliseconds = mailQuotaWindowMilliseconds

function cutoffMilliseconds(now: number, rule: MailQuotaRule) {
  return Math.max(0, now - mailQuotaWindowMilliseconds(rule))
}

function counter(rule: MailQuotaRule, completed: number, pending: number): MailQuotaCounter {
  const used = completed + pending
  return {
    rule,
    completed,
    pending,
    used,
    remaining: rule.limit < 0 ? null : Math.max(0, rule.limit - used),
  }
}

function appliedCounter(assignment: MailQuotaAssignment, counts: RawCounter): AppliedMailQuotaCounter {
  const lifetimeUsed = counts.lifetimeCompleted + counts.lifetimePending
  return {
    assignment,
    rolling: counter(assignment.rolling, counts.completed, counts.pending),
    lifetimeCompleted: counts.lifetimeCompleted,
    lifetimePending: counts.lifetimePending,
    lifetimeUsed,
    lifetimeRemaining: assignment.lifetimeLimit < 0
      ? null
      : Math.max(0, assignment.lifetimeLimit - lifetimeUsed),
  }
}

function targetConditions(assignment: MailQuotaAssignment) {
  if (assignment.target.type === "domain") {
    return { column: "sender_domain", value: assignment.target.domain }
  }
  if (assignment.target.type === "mailbox") {
    return { column: "mailbox_address", value: assignment.target.address }
  }
  return null
}

function assignmentRuleCondition(assignment: MailQuotaAssignment) {
  return {
    column: assignment.subject.type === "all" ? "global_rule_id" : "scoped_rule_id",
    value: assignment.id,
    // Version-4 events had no rule-id columns. Only an identity whose ID
    // exactly matches the deterministic migration ID may claim NULL history.
    includeLegacy: isMigratedMailQuotaAssignment(assignment),
  } as const
}

function assignmentFilter(userId: string, role: Role, assignment: MailQuotaAssignment): CounterFilter {
  if (assignment.subject.type === "all") {
    return { column: "all", excludeEmperor: assignment.ignoreEmperor }
  }
  if (assignment.subject.type === "role" && assignment.shareWithinRole) {
    return { column: "policy_role" as const, value: role }
  }
  return { column: "user_id" as const, value: userId }
}

function sqliteCounter(
  filter: CounterFilter,
  direction: MailDirection,
  assignment: MailQuotaAssignment,
  now: number,
): RawCounter {
  const target = targetConditions(assignment)
  const assignmentRule = assignmentRuleCondition(assignment)
  const targetClause = target ? ` AND ${target.column} = ?` : ""
  const assignmentClause = assignmentRule.includeLegacy
    ? `(${assignmentRule.column} = ? OR ${assignmentRule.column} IS NULL)`
    : `${assignmentRule.column} = ?`
  const filterClause = filter.column === "all"
    ? filter.excludeEmperor
      ? "policy_role <> ?"
      : "1 = 1"
    : `${filter.column} = ?`
  const filterValues = filter.column === "all"
    ? filter.excludeEmperor ? [ROLES.EMPEROR] : []
    : [filter.value]
  const row = sqliteHandle().prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'sent' AND created_at >= ? THEN 1 ELSE 0 END), 0) AS completed,
      COALESCE(SUM(CASE WHEN status = 'reserved' AND created_at >= ? AND reservation_expires_at > ? THEN 1 ELSE 0 END), 0) AS pending,
      COALESCE(SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END), 0) AS lifetime_completed,
      COALESCE(SUM(CASE WHEN status = 'reserved' AND reservation_expires_at > ? THEN 1 ELSE 0 END), 0) AS lifetime_pending
    FROM send_quota_event
    WHERE ${filterClause} AND direction = ? AND ${assignmentClause}${targetClause}
  `).get(
    cutoffMilliseconds(now, assignment.rolling),
    cutoffMilliseconds(now, assignment.rolling),
    now,
    now,
    ...filterValues,
    direction,
    assignmentRule.value,
    ...(target ? [target.value] : []),
  ) as {
    completed: number
    pending: number
    lifetime_completed: number
    lifetime_pending: number
  }
  return {
    completed: Number(row.completed),
    pending: Number(row.pending),
    lifetimeCompleted: Number(row.lifetime_completed),
    lifetimePending: Number(row.lifetime_pending),
  }
}

async function postgresCounter(
  query: Query,
  filter: CounterFilter,
  direction: MailDirection,
  assignment: MailQuotaAssignment,
  now: number,
): Promise<RawCounter> {
  const target = targetConditions(assignment)
  const assignmentRule = assignmentRuleCondition(assignment)
  const values: unknown[] = [
    direction,
    new Date(cutoffMilliseconds(now, assignment.rolling)),
    new Date(now),
  ]
  const filterClause = filter.column === "all"
    ? filter.excludeEmperor
      ? `policy_role <> $${values.push(ROLES.EMPEROR)}`
      : "1 = 1"
    : `${filter.column} = $${values.push(filter.value)}`
  const targetClause = target ? ` AND ${target.column} = $${values.length + 1}` : ""
  if (target) values.push(target.value)
  const assignmentParameter = `$${values.push(assignmentRule.value)}`
  const assignmentClause = assignmentRule.includeLegacy
    ? ` AND (${assignmentRule.column} = ${assignmentParameter} OR ${assignmentRule.column} IS NULL)`
    : ` AND ${assignmentRule.column} = ${assignmentParameter}`
  const result = await query<{
    completed: string
    pending: string
    lifetime_completed: string
    lifetime_pending: string
  }>(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'sent' AND created_at >= $2) AS completed,
      COUNT(*) FILTER (WHERE status = 'reserved' AND created_at >= $2 AND reservation_expires_at > $3) AS pending,
      COUNT(*) FILTER (WHERE status = 'sent') AS lifetime_completed,
      COUNT(*) FILTER (WHERE status = 'reserved' AND reservation_expires_at > $3) AS lifetime_pending
    FROM send_quota_event
    WHERE ${filterClause} AND direction = $1${targetClause}${assignmentClause}
  `, values)
  return {
    completed: Number(result.rows[0]?.completed ?? 0),
    pending: Number(result.rows[0]?.pending ?? 0),
    lifetimeCompleted: Number(result.rows[0]?.lifetime_completed ?? 0),
    lifetimePending: Number(result.rows[0]?.lifetime_pending ?? 0),
  }
}

function mailboxDomain(address: string) {
  return address.slice(address.lastIndexOf("@") + 1)
}

function directionPermission(access: EffectiveAccessPolicy, direction: MailDirection) {
  return direction === "send"
    ? access.permissions[PERMISSIONS.SEND_EMAIL]
    : access.permissions[PERMISSIONS.RECEIVE_EMAIL]
}

function permissionError(direction: MailDirection): MailQuotaError {
  return direction === "send" ? "SEND_PERMISSION_DENIED" : "RECEIVE_PERMISSION_DENIED"
}

function domainError(direction: MailDirection): MailQuotaError {
  return direction === "send" ? "MAIL_DOMAIN_SEND_FORBIDDEN" : "MAIL_DOMAIN_RECEIVE_FORBIDDEN"
}

function checkError(direction: MailDirection): MailQuotaError {
  return direction === "send" ? "SEND_PERMISSION_CHECK_FAILED" : "RECEIVE_PERMISSION_CHECK_FAILED"
}

function quotaError(snapshot: MailQuotaSnapshot, units = 1): MailQuotaError | undefined {
  const prefix = snapshot.direction === "send" ? "SEND" : "RECEIVE"
  for (const applied of snapshot.applied) {
    if (applied.rolling.rule.limit === 0 || (
      applied.rolling.rule.limit > 0 && applied.rolling.used + units > applied.rolling.rule.limit
    )) {
      if (applied.assignment.subject.type === "all") {
        return `${prefix}_GLOBAL_QUOTA_EXCEEDED` as MailQuotaError
      }
      const target = applied.assignment.target.type === "all"
        ? "TOTAL"
        : applied.assignment.target.type === "domain" ? "DOMAIN" : "MAILBOX"
      return `${prefix}_${target}_QUOTA_EXCEEDED` as MailQuotaError
    }
    if (applied.assignment.target.type === "mailbox" && (
      applied.assignment.lifetimeLimit === 0
      || (applied.assignment.lifetimeLimit > 0 && applied.lifetimeUsed + units > applied.assignment.lifetimeLimit)
    )) return `${prefix}_MAILBOX_LIFETIME_QUOTA_EXCEEDED` as MailQuotaError
  }
  return undefined
}

async function readSnapshot(
  userId: string,
  mailboxAddress: string,
  access: EffectiveAccessPolicy,
  direction: MailDirection,
  query?: Query,
  resolvedAssignments?: MailQuotaAssignment[],
) {
  const assignments = resolvedAssignments ?? resolveMailQuotaAssignments(access, direction, mailboxAddress)
  const snapshot: MailQuotaSnapshot = {
    direction,
    subject: quotaSubject(userId),
    role: access.quotaRole,
    applied: [],
  }
  const now = Date.now()
  snapshot.applied = await Promise.all(assignments.map(async assignment => {
    const filter = assignmentFilter(userId, access.quotaRole, assignment)
    const counts = activeDriver() === "sqlite"
      ? sqliteCounter(filter, direction, assignment, now)
      : await postgresCounter(query ?? getPostgresPool().query.bind(getPostgresPool()) as Query, filter, direction, assignment, now)
    return appliedCounter(assignment, counts)
  }))
  return snapshot
}

export async function checkMailPermission(
  userId: string,
  mailboxAddressValue: string,
  direction: MailDirection,
  resolvedAccess?: EffectiveAccessPolicy,
): Promise<MailPermissionResult> {
  try {
    const access = resolvedAccess ?? await getUserAccessPolicy(userId)
    if (!directionPermission(access, direction)) return { allowed: false, error: permissionError(direction) }
    const mailboxAddress = normalizeMailboxAddress(mailboxAddressValue)
    if (!mailboxAddress) return { allowed: false, error: checkError(direction) }
    if (!isDomainOperationAllowed(access, mailboxDomain(mailboxAddress), direction)) {
      return { allowed: false, error: domainError(direction) }
    }
    const quota = await readSnapshot(userId, mailboxAddress, access, direction)
    const error = quotaError(quota)
    return {
      allowed: !error,
      ...(error ? { error } : {}),
      quota,
      remaining: minimumRemaining(quota.applied),
    }
  } catch (error) {
    console.error("mail.permission.check_failed", {
      direction,
      name: error instanceof Error ? error.name : "UnknownError",
    })
    return { allowed: false, error: checkError(direction) }
  }
}

function sendSnapshot(snapshot: MailQuotaSnapshot): SendQuotaSnapshot {
  return {
    ...snapshot,
    applied: snapshot.applied.map(item => ({
      ...item,
      rolling: { ...item.rolling, sent: item.rolling.completed },
    })),
  }
}

export async function checkSendPermission(
  userId: string,
  senderDomainOrAddress?: string | null,
  resolvedAccess?: EffectiveAccessPolicy,
): Promise<SendPermissionResult> {
  const value = senderDomainOrAddress == null ? null : String(senderDomainOrAddress)
  const address = value?.includes("@")
    ? normalizeMailboxAddress(value)
    : normalizeMailboxDomain(value)
      ? `__quota__@${normalizeMailboxDomain(value)}`
      : null
  if (!address) {
    return { canSend: false, error: senderDomainOrAddress == null ? permissionError("send") : checkError("send") }
  }
  const result = await checkMailPermission(userId, address, "send", resolvedAccess)
  return {
    canSend: result.allowed,
    error: result.error,
    quota: result.quota ? sendSnapshot(result.quota) : undefined,
    remainingEmails: result.remaining,
  }
}

export async function reserveMailQuota(
  userId: string,
  mailboxAddressValue: string,
  direction: MailDirection,
  resolvedAccess?: EffectiveAccessPolicy,
  units = 1,
): Promise<MailPermissionResult & { reservation?: MailQuotaReservation; reservations?: MailQuotaReservation[] }> {
  if (!Number.isSafeInteger(units) || units < 1 || units > 50) return { allowed: false, error: checkError(direction) }
  const access = resolvedAccess ?? await getUserAccessPolicy(userId)
  if (!directionPermission(access, direction)) return { allowed: false, error: permissionError(direction) }
  const mailboxAddress = normalizeMailboxAddress(mailboxAddressValue)
  if (!mailboxAddress) return { allowed: false, error: checkError(direction) }
  const domain = mailboxDomain(mailboxAddress)
  if (!isDomainOperationAllowed(access, domain, direction)) return { allowed: false, error: domainError(direction) }
  const assignments = resolveMailQuotaAssignments(access, direction, mailboxAddress)

  const now = Date.now()
  const expiresAt = now + RESERVATION_LEASE_MILLISECONDS
  const subject = quotaSubject(userId)
  const ids = Array.from({ length: units }, () => randomUUID())
  const reservations = ids.map(id => ({
    id,
    direction,
    userId,
    subject,
    domain,
    mailboxAddress,
    createdAt: new Date(now),
    expiresAt: new Date(expiresAt),
  }))
  const finalize = (snapshot: MailQuotaSnapshot) => {
    const error = quotaError(snapshot, units)
    if (error) return { allowed: false as const, error, quota: snapshot }
    const quota = snapshot.applied.length > 0 ? {
      ...snapshot,
      applied: snapshot.applied.map(item => appliedCounter(item.assignment, {
        completed: item.rolling.completed,
        pending: item.rolling.pending + units,
        lifetimeCompleted: item.lifetimeCompleted,
        lifetimePending: item.lifetimePending + units,
      })),
    } : snapshot
    return {
      allowed: true as const,
      quota,
      remaining: minimumRemaining(quota.applied),
      reservation: reservations[0],
      reservations,
    }
  }

  if (activeDriver() === "sqlite") {
    return sqliteHandle().transaction(() => {
      const snapshot: MailQuotaSnapshot = {
        direction,
        subject,
        role: access.quotaRole,
        applied: assignments.map(assignment => appliedCounter(
          assignment,
          sqliteCounter(assignmentFilter(userId, access.quotaRole, assignment), direction, assignment, now),
        )),
      }
      const result = finalize(snapshot)
      if (!result.allowed) return result
      const insert = sqliteHandle().prepare(`
        INSERT INTO send_quota_event
          (id, user_id, quota_subject, policy_role, direction, sender_domain, mailbox_address, global_rule_id, scoped_rule_id, status, created_at, reservation_expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)
      `)
      const eventSubject = assignments.some(assignment => assignment.subject.type === "role" && assignment.shareWithinRole)
          ? `role:${access.quotaRole}`
          : subject
      const globalRuleId = assignments.find(assignment => assignment.subject.type === "all")?.id ?? null
      const scopedRuleId = assignments.find(assignment => assignment.subject.type !== "all")?.id ?? null
      for (const id of ids) insert.run(id, userId, eventSubject, access.quotaRole, direction, domain, mailboxAddress, globalRuleId, scopedRuleId, now, expiresAt)
      return result
    }).immediate()
  }

  const client = await getPostgresPool().connect()
  try {
    await client.query("BEGIN")
    // Resets take the exclusive form of this lock. Shared acquisition keeps
    // ordinary reservations concurrent while preventing a reset from deleting
    // usage underneath an in-flight reservation transaction.
    await client.query(
      "SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))",
      [`mail-quota:${direction}:maintenance`],
    )
    const lockKeys = [...new Set(assignments.map(assignment => {
      const shared = assignment.subject.type === "all"
        || (assignment.subject.type === "role" && assignment.shareWithinRole)
      return shared
        ? `mail-quota:${direction}:shared:${assignment.id}`
        : `mail-quota:${direction}:user:${userId}:${assignment.id}`
    }))].sort()
    for (const key of lockKeys) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key])
    }
    const query = client.query.bind(client) as Query
    const snapshot = await readSnapshot(userId, mailboxAddress, access, direction, query, assignments)
    const result = finalize(snapshot)
    if (result.allowed) {
      const eventSubject = snapshot.applied.some(item => item.assignment.subject.type === "role" && item.assignment.shareWithinRole)
          ? `role:${access.quotaRole}`
          : subject
      await client.query(`
        INSERT INTO send_quota_event
          (id, user_id, quota_subject, policy_role, direction, sender_domain, mailbox_address, global_rule_id, scoped_rule_id, status, created_at, reservation_expires_at)
        SELECT id, $2, $3, $4, $5, $6, $7, $8, $9, 'reserved', $10, $11
        FROM UNNEST($1::text[]) AS ids(id)
      `, [
        ids,
        userId,
        eventSubject,
        access.quotaRole,
        direction,
        domain,
        mailboxAddress,
        assignments.find(assignment => assignment.subject.type === "all")?.id ?? null,
        assignments.find(assignment => assignment.subject.type !== "all")?.id ?? null,
        new Date(now),
        new Date(expiresAt),
      ])
    }
    await client.query(result.allowed ? "COMMIT" : "ROLLBACK")
    return result
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export async function reserveSendQuota(
  userId: string,
  senderAddressOrDomain: string,
  resolvedAccess?: EffectiveAccessPolicy,
  units = 1,
): Promise<SendPermissionResult & { reservation?: SendQuotaReservation; reservations?: SendQuotaReservation[] }> {
  const address = senderAddressOrDomain.includes("@") ? senderAddressOrDomain : `__quota__@${senderAddressOrDomain}`
  const result = await reserveMailQuota(userId, address, "send", resolvedAccess, units)
  return {
    canSend: result.allowed,
    error: result.error,
    quota: result.quota ? sendSnapshot(result.quota) : undefined,
    remainingEmails: result.remaining,
    reservation: result.reservation,
    reservations: result.reservations,
  }
}

export async function completeMailQuotaReservations(reservations: MailQuotaReservation[]) {
  if (reservations.length === 0) return
  const direction = reservations[0].direction
  if (reservations.some(item => item.direction !== direction)) throw new Error("MAIL_QUOTA_RESERVATION_DIRECTION_MISMATCH")
  const ids = reservations.map(item => item.id)
  if (activeDriver() === "sqlite") {
    return sqliteHandle().transaction(() => {
      const update = sqliteHandle().prepare(`
        UPDATE send_quota_event SET status = 'sent', completed_at = ?
        WHERE id = ? AND status = 'reserved' AND direction = ?
      `)
      const completedAt = Date.now()
      for (const id of ids) {
        if (update.run(completedAt, id, direction).changes !== 1) throw new Error("MAIL_QUOTA_RESERVATION_NOT_FOUND")
      }
    }).immediate()
  }
  const client = await getPostgresPool().connect()
  try {
    await client.query("BEGIN")
    const result = await client.query(`
      UPDATE send_quota_event SET status = 'sent', completed_at = NOW()
      WHERE id = ANY($1::text[]) AND status = 'reserved' AND direction = $2
    `, [ids, direction])
    if (result.rowCount !== ids.length) throw new Error("MAIL_QUOTA_RESERVATION_NOT_FOUND")
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export const completeSendQuotaReservations = completeMailQuotaReservations

export async function completeMailQuotaReservation(reservation: MailQuotaReservation) {
  if (activeDriver() === "sqlite") {
    const result = sqliteHandle().prepare(`
      UPDATE send_quota_event SET status = 'sent', completed_at = ?
      WHERE id = ? AND status = 'reserved' AND direction = ?
    `).run(Date.now(), reservation.id, reservation.direction)
    if (result.changes !== 1) throw new Error("MAIL_QUOTA_RESERVATION_NOT_FOUND")
    return
  }
  const result = await getPostgresPool().query(`
    UPDATE send_quota_event SET status = 'sent', completed_at = NOW()
    WHERE id = $1 AND status = 'reserved' AND direction = $2
  `, [reservation.id, reservation.direction])
  if (result.rowCount !== 1) throw new Error("MAIL_QUOTA_RESERVATION_NOT_FOUND")
}

export const completeSendQuotaReservation = completeMailQuotaReservation

export async function releaseMailQuotaReservation(reservation: MailQuotaReservation) {
  if (activeDriver() === "sqlite") {
    sqliteHandle().prepare("DELETE FROM send_quota_event WHERE id = ? AND status = 'reserved' AND direction = ?")
      .run(reservation.id, reservation.direction)
    return
  }
  await getPostgresPool().query(
    "DELETE FROM send_quota_event WHERE id = $1 AND status = 'reserved' AND direction = $2",
    [reservation.id, reservation.direction],
  )
}

export const releaseSendQuotaReservation = releaseMailQuotaReservation

export async function releaseMailQuotaReservations(reservations: MailQuotaReservation[]) {
  if (reservations.length === 0) return
  const direction = reservations[0].direction
  if (reservations.some(item => item.direction !== direction)) throw new Error("MAIL_QUOTA_RESERVATION_DIRECTION_MISMATCH")
  const ids = reservations.map(item => item.id)
  if (activeDriver() === "sqlite") {
    return sqliteHandle().transaction(() => {
      const remove = sqliteHandle().prepare(
        "DELETE FROM send_quota_event WHERE id = ? AND status = 'reserved' AND direction = ?",
      )
      for (const id of ids) remove.run(id, direction)
    }).immediate()
  }
  await getPostgresPool().query(
    "DELETE FROM send_quota_event WHERE id = ANY($1::text[]) AND status = 'reserved' AND direction = $2",
    [ids, direction],
  )
}

export const releaseSendQuotaReservations = releaseMailQuotaReservations

async function allTimeCompleted(
  filter: CounterFilter,
  direction: MailDirection,
  assignedRuleColumn?: "global_rule_id" | "scoped_rule_id",
) {
  const assignedRuleClause = assignedRuleColumn ? ` AND ${assignedRuleColumn} IS NOT NULL` : ""
  if (activeDriver() === "sqlite") {
    const sqliteFilter = filter.column === "all"
      ? filter.excludeEmperor
        ? "policy_role <> ?"
        : "1 = 1"
      : `${filter.column} = ?`
    const sqliteValues = filter.column === "all"
      ? filter.excludeEmperor ? [ROLES.EMPEROR] : []
      : [filter.value]
    const row = sqliteHandle().prepare(`
      SELECT COUNT(*) AS count FROM send_quota_event
      WHERE ${sqliteFilter} AND direction = ? AND status = 'sent'${assignedRuleClause}
    `).get(...sqliteValues, direction) as { count: number }
    return Number(row.count)
  }
  const filterClause = filter.column === "all"
    ? filter.excludeEmperor
      ? "policy_role <> $2"
      : "1 = 1"
    : `${filter.column} = $2`
  const result = await getPostgresPool().query<{ count: string }>(`
    SELECT COUNT(*) AS count FROM send_quota_event
    WHERE ${filterClause} AND direction = $1 AND status = 'sent'${assignedRuleClause}
  `, filter.column === "all"
    ? filter.excludeEmperor ? [direction, ROLES.EMPEROR] : [direction]
    : [direction, filter.value])
  return Number(result.rows[0]?.count ?? 0)
}

async function buildUsage(
  target: MailQuotaUsage["target"],
  access: EffectiveAccessPolicy,
  direction: MailDirection,
  filter: CounterFilter,
  aggregate: boolean,
  assignedRuleColumn?: "global_rule_id" | "scoped_rule_id",
): Promise<MailQuotaUsage> {
  const rules = effectiveMailQuotaAssignments(access, direction)
  const now = Date.now()
  const counters = await Promise.all(rules.map(async assignment => {
    const ruleFilter = target.type === "user"
      ? assignmentFilter(target.id, access.quotaRole, assignment)
      : assignment.subject.type === "all"
        ? { column: "all" as const, excludeEmperor: assignment.ignoreEmperor }
        : assignment.subject.type === "role" && assignment.shareWithinRole
          ? { column: "policy_role" as const, value: access.quotaRole }
          : filter
    const counts = activeDriver() === "sqlite"
      ? sqliteCounter(ruleFilter, direction, assignment, now)
      : await postgresCounter(getPostgresPool().query.bind(getPostgresPool()) as Query, ruleFilter, direction, assignment, now)
    const applied = appliedCounter(assignment, counts)
    const shared = assignment.subject.type === "all"
      || (assignment.subject.type === "role" && assignment.shareWithinRole)
    return aggregate && !shared ? {
      ...applied,
      rolling: { ...applied.rolling, remaining: null },
      lifetimeRemaining: null,
    } : applied
  }))
  return {
    direction,
    target,
    aggregate,
    allTimeCompleted: await allTimeCompleted(filter, direction, assignedRuleColumn),
    rules: counters,
  }
}

export function getRoleMailQuotaUsage(role: Role, access: EffectiveAccessPolicy, direction: MailDirection) {
  return buildUsage({ type: "role", id: role }, access, direction, { column: "policy_role", value: role }, true)
}

export function getUserMailQuotaUsage(userId: string, access: EffectiveAccessPolicy, direction: MailDirection) {
  return buildUsage({ type: "user", id: userId }, access, direction, { column: "user_id", value: userId }, false)
}

export function getGlobalMailQuotaUsage(access: EffectiveAccessPolicy, direction: MailDirection) {
  return buildUsage(
    { type: "all", id: "all" },
    { ...access, mailQuotaRules: access.mailQuotaRules.filter(rule => rule.subject.type === "all") },
    direction,
    { column: "all", excludeEmperor: false },
    true,
    "global_rule_id",
  )
}

function toSendUsage(value: MailQuotaUsage): SendQuotaUsage {
  return {
    ...value,
    allTimeSent: value.allTimeCompleted,
    rules: value.rules.map(rule => ({
      ...rule,
      rolling: { ...rule.rolling, sent: rule.rolling.completed },
    })),
  }
}

export async function getRoleSendQuotaUsage(role: Role, access: EffectiveAccessPolicy) {
  return toSendUsage(await getRoleMailQuotaUsage(role, access, "send"))
}

export async function getUserSendQuotaUsage(userId: string, access: EffectiveAccessPolicy) {
  return toSendUsage(await getUserMailQuotaUsage(userId, access, "send"))
}

export async function resetMailQuotaUsage(input: {
  direction: MailDirection
  all?: boolean
  userId?: string
  role?: Role
  mailboxAddress?: string
}) {
  const address = input.mailboxAddress == null ? null : normalizeMailboxAddress(input.mailboxAddress)
  if (input.mailboxAddress != null && !address) throw new Error("INVALID_MAILBOX_ADDRESS")
  if ([input.all === true, Boolean(input.userId), Boolean(input.role)].filter(Boolean).length !== 1) {
    throw new Error("QUOTA_RESET_TARGET_REQUIRED")
  }
  const conditions = ["direction = ?", "status = 'sent'"]
  const values: string[] = [input.direction]
  if (input.all) conditions.push("global_rule_id IS NOT NULL")
  else if (input.userId) { conditions.push("user_id = ?"); values.push(input.userId) }
  else if (input.role) { conditions.push("policy_role = ?"); values.push(input.role) }
  if (address) { conditions.push("mailbox_address = ?"); values.push(address) }
  if (activeDriver() === "sqlite") {
    return sqliteHandle().transaction(() => (
      sqliteHandle().prepare(`DELETE FROM send_quota_event WHERE ${conditions.join(" AND ")}`).run(...values).changes
    )).immediate()
  }
  let parameter = 0
  const pgConditions = conditions.map(condition => condition.replace("?", () => `$${++parameter}`))
  const client = await getPostgresPool().connect()
  try {
    await client.query("BEGIN")
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`mail-quota:${input.direction}:maintenance`],
    )
    const result = await client.query(`DELETE FROM send_quota_event WHERE ${pgConditions.join(" AND ")}`, values)
    await client.query("COMMIT")
    return result.rowCount ?? 0
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
