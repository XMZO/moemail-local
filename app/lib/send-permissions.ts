import { randomUUID } from "node:crypto"
import type {
  EffectiveAccessPolicy,
  MailDirection,
  MailQuotaRule,
  MailboxQuotaRule,
} from "./access-policies"
import {
  isDomainOperationAllowed,
  mailboxQuotaRuleForAddress,
  mailQuotaForDirection,
  mailQuotaRoleForDirection,
  mailQuotaRuleForDomain,
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
import { PERMISSIONS } from "./permissions"
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

export interface MailboxQuotaCounter {
  address: string
  rule: MailboxQuotaRule
  rolling: MailQuotaCounter
  lifetimeCompleted: number
  lifetimePending: number
  lifetimeUsed: number
  lifetimeRemaining: number | null
}

export interface MailQuotaSnapshot {
  direction: MailDirection
  subject: string
  scope: "user" | "role"
  role: EffectiveAccessPolicy["sendQuotaRole"]
  total: MailQuotaCounter
  domain?: MailQuotaCounter & { domain: string }
  mailbox?: MailboxQuotaCounter
}

export interface SendQuotaSnapshot {
  subject: string
  scope: "user" | "role"
  role: EffectiveAccessPolicy["sendQuotaRole"]
  total: SendQuotaCounter
  domain?: SendQuotaCounter & { domain: string }
  mailbox?: MailboxQuotaCounter
}

export interface MailQuotaUsage {
  direction: MailDirection
  target: { type: "role" | "user"; id: string }
  scope: "user" | "role"
  role: EffectiveAccessPolicy["sendQuotaRole"]
  aggregate: boolean
  allTimeCompleted: number
  total: MailQuotaCounter
  domains: Array<MailQuotaCounter & { domain: string; allTimeCompleted: number }>
}

export interface SendQuotaUsage {
  target: { type: "role" | "user"; id: string }
  scope: "user" | "role"
  role: EffectiveAccessPolicy["sendQuotaRole"]
  aggregate: boolean
  allTimeSent: number
  total: SendQuotaCounter
  domains: Array<SendQuotaCounter & { domain: string; allTimeSent: number }>
}

export type MailQuotaError =
  | "SEND_PERMISSION_DENIED"
  | "RECEIVE_PERMISSION_DENIED"
  | "MAIL_DOMAIN_SEND_FORBIDDEN"
  | "MAIL_DOMAIN_RECEIVE_FORBIDDEN"
  | "SEND_TOTAL_QUOTA_EXCEEDED"
  | "SEND_DOMAIN_QUOTA_EXCEEDED"
  | "SEND_MAILBOX_QUOTA_EXCEEDED"
  | "SEND_MAILBOX_LIFETIME_QUOTA_EXCEEDED"
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

type Counter = { completed: number; pending: number }
type MailQuotaSqlite = ReturnType<typeof getSqlite>
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

function quotaSubject(
  userId: string,
  access: EffectiveAccessPolicy,
  direction: MailDirection,
) {
  const policy = mailQuotaForDirection(access, direction)
  const role = mailQuotaRoleForDirection(access, direction)
  return policy.scope === "role" ? `role:${role}` : `user:${userId}`
}

export function mailQuotaWindowMilliseconds(rule: MailQuotaRule) {
  const duration = rule.windowValue * UNIT_MILLISECONDS[rule.windowUnit]
  return Number.isSafeInteger(duration) ? duration : Number.MAX_SAFE_INTEGER
}

export const sendQuotaWindowMilliseconds = mailQuotaWindowMilliseconds

function cutoffMilliseconds(now: number, rule: MailQuotaRule) {
  return Math.max(0, now - mailQuotaWindowMilliseconds(rule))
}

function counter(rule: MailQuotaRule, counts: Counter): MailQuotaCounter {
  const used = counts.completed + counts.pending
  return {
    rule,
    ...counts,
    used,
    remaining: rule.limit < 0 ? null : Math.max(0, rule.limit - used),
  }
}

function sendCounter(value: MailQuotaCounter): SendQuotaCounter {
  return { ...value, sent: value.completed }
}

function mailboxCounter(
  address: string,
  rule: MailboxQuotaRule,
  rolling: Counter,
  lifetime: Counter,
): MailboxQuotaCounter {
  const lifetimeUsed = lifetime.completed + lifetime.pending
  return {
    address,
    rule,
    rolling: counter(rule.rolling, rolling),
    lifetimeCompleted: lifetime.completed,
    lifetimePending: lifetime.pending,
    lifetimeUsed,
    lifetimeRemaining: rule.lifetimeLimit < 0
      ? null
      : Math.max(0, rule.lifetimeLimit - lifetimeUsed),
  }
}

function errorPrefix(direction: MailDirection) {
  return direction === "send" ? "SEND" : "RECEIVE"
}

function quotaError(snapshot: MailQuotaSnapshot): MailQuotaError | undefined {
  const prefix = errorPrefix(snapshot.direction)
  if (snapshot.total.rule.limit === 0 || (
    snapshot.total.rule.limit > 0 && snapshot.total.used >= snapshot.total.rule.limit
  )) return `${prefix}_TOTAL_QUOTA_EXCEEDED` as MailQuotaError

  const domain = snapshot.domain
  if (domain && (domain.rule.limit === 0 || (
    domain.rule.limit > 0 && domain.used >= domain.rule.limit
  ))) return `${prefix}_DOMAIN_QUOTA_EXCEEDED` as MailQuotaError

  const mailbox = snapshot.mailbox
  if (mailbox && (mailbox.rolling.rule.limit === 0 || (
    mailbox.rolling.rule.limit > 0 && mailbox.rolling.used >= mailbox.rolling.rule.limit
  ))) return `${prefix}_MAILBOX_QUOTA_EXCEEDED` as MailQuotaError
  if (mailbox && (mailbox.rule.lifetimeLimit === 0 || (
    mailbox.rule.lifetimeLimit > 0 && mailbox.lifetimeUsed >= mailbox.rule.lifetimeLimit
  ))) return `${prefix}_MAILBOX_LIFETIME_QUOTA_EXCEEDED` as MailQuotaError

  return undefined
}

function sqliteCounter(
  subject: string,
  userId: string,
  direction: MailDirection,
  domain: string | null,
  mailboxAddress: string | null,
  rule: MailQuotaRule | null,
  now: number,
): Counter {
  // Aggregate limits may be shared by a role. Mailbox limits always belong to
  // the concrete user and address so one role member cannot consume another
  // member's mailbox lifetime allowance.
  const conditions = [mailboxAddress === null ? "quota_subject = ?" : "user_id = ?", "direction = ?"]
  const values: Array<string | number> = [mailboxAddress === null ? subject : userId, direction]
  if (domain !== null) {
    conditions.push("sender_domain = ?")
    values.push(domain)
  }
  if (mailboxAddress !== null) {
    conditions.push("mailbox_address = ?")
    values.push(mailboxAddress)
  }
  const cutoff = rule ? cutoffMilliseconds(now, rule) : 0
  const row = sqliteHandle().prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'sent' AND created_at >= ? THEN 1 ELSE 0 END), 0) AS completed,
      COALESCE(SUM(CASE WHEN status = 'reserved' AND created_at >= ? AND reservation_expires_at > ? THEN 1 ELSE 0 END), 0) AS pending
    FROM send_quota_event
    WHERE ${conditions.join(" AND ")}
  `).get(cutoff, cutoff, now, ...values) as { completed: number; pending: number }
  return { completed: Number(row.completed), pending: Number(row.pending) }
}

type Query = (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, string | number>> }>

async function postgresCounter(
  query: Query,
  subject: string,
  userId: string,
  direction: MailDirection,
  domain: string | null,
  mailboxAddress: string | null,
  rule: MailQuotaRule | null,
  now: number,
): Promise<Counter> {
  const conditions = [mailboxAddress === null ? "quota_subject = $1" : "user_id = $1", "direction = $2"]
  const values: unknown[] = [mailboxAddress === null ? subject : userId, direction, new Date(rule ? cutoffMilliseconds(now, rule) : 0), new Date(now)]
  if (domain !== null) {
    values.push(domain)
    conditions.push(`sender_domain = $${values.length}`)
  }
  if (mailboxAddress !== null) {
    values.push(mailboxAddress)
    conditions.push(`mailbox_address = $${values.length}`)
  }
  const result = await query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'sent' AND created_at >= $3) AS completed,
      COUNT(*) FILTER (WHERE status = 'reserved' AND created_at >= $3 AND reservation_expires_at > $4) AS pending
    FROM send_quota_event
    WHERE ${conditions.join(" AND ")}
  `, values)
  return {
    completed: Number(result.rows[0]?.completed ?? 0),
    pending: Number(result.rows[0]?.pending ?? 0),
  }
}

function mailboxDomain(address: string) {
  return address.slice(address.lastIndexOf("@") + 1)
}

async function snapshotWithCounter(
  userId: string,
  mailboxAddress: string,
  access: EffectiveAccessPolicy,
  direction: MailDirection,
  read: (
    domain: string | null,
    mailbox: string | null,
    rule: MailQuotaRule | null,
  ) => Counter | Promise<Counter>,
) {
  const policy = mailQuotaForDirection(access, direction)
  const role = mailQuotaRoleForDirection(access, direction)
  const subject = quotaSubject(userId, access, direction)
  const domain = mailboxDomain(mailboxAddress)
  const domainRule = mailQuotaRuleForDomain(access, direction, domain)
  const mailboxRule = mailboxQuotaRuleForAddress(access, direction, mailboxAddress)
  const [totalCounts, domainCounts, mailboxRollingCounts, mailboxLifetimeCounts] = await Promise.all([
    read(null, null, policy.total),
    read(domain, null, domainRule),
    read(null, mailboxAddress, mailboxRule.rolling),
    read(null, mailboxAddress, null),
  ])
  return {
    direction,
    subject,
    scope: policy.scope,
    role,
    total: counter(policy.total, totalCounts),
    domain: { domain, ...counter(domainRule, domainCounts) },
    mailbox: mailboxCounter(mailboxAddress, mailboxRule, mailboxRollingCounts, mailboxLifetimeCounts),
  } satisfies MailQuotaSnapshot
}

async function readSnapshot(
  userId: string,
  mailboxAddress: string,
  access: EffectiveAccessPolicy,
  direction: MailDirection,
  now = Date.now(),
) {
  if (activeDriver() === "sqlite") {
    return snapshotWithCounter(userId, mailboxAddress, access, direction, (domain, mailbox, rule) => (
      sqliteCounter(quotaSubject(userId, access, direction), userId, direction, domain, mailbox, rule, now)
    ))
  }
  const query = getPostgresPool().query.bind(getPostgresPool()) as unknown as Query
  return snapshotWithCounter(userId, mailboxAddress, access, direction, (domain, mailbox, rule) => (
    postgresCounter(query, quotaSubject(userId, access, direction), userId, direction, domain, mailbox, rule, now)
  ))
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
    const domain = mailboxDomain(mailboxAddress)
    if (!isDomainOperationAllowed(access, domain, direction)) {
      return { allowed: false, error: domainError(direction) }
    }
    const quota = await readSnapshot(userId, mailboxAddress, access, direction)
    const error = quotaError(quota)
    return {
      allowed: !error,
      ...(error ? { error } : {}),
      quota,
      remaining: quota.total.remaining ?? undefined,
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
    total: sendCounter(snapshot.total),
    domain: snapshot.domain ? { ...sendCounter(snapshot.domain), domain: snapshot.domain.domain } : undefined,
  }
}

export async function checkSendPermission(
  userId: string,
  senderDomainOrAddress?: string | null,
  resolvedAccess?: EffectiveAccessPolicy,
): Promise<SendPermissionResult> {
  const access = resolvedAccess ?? await getUserAccessPolicy(userId)
  const value = senderDomainOrAddress == null ? null : String(senderDomainOrAddress)
  const address = value?.includes("@")
    ? normalizeMailboxAddress(value)
    : normalizeMailboxDomain(value)
      ? `__quota__@${normalizeMailboxDomain(value)}`
      : null
  if (!address) {
    return {
      canSend: false,
      error: senderDomainOrAddress == null ? permissionError("send") : checkError("send"),
    }
  }
  const result = await checkMailPermission(userId, address, "send", access)
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
): Promise<MailPermissionResult & { reservation?: MailQuotaReservation }> {
  const access = resolvedAccess ?? await getUserAccessPolicy(userId)
  if (!directionPermission(access, direction)) return { allowed: false, error: permissionError(direction) }
  const mailboxAddress = normalizeMailboxAddress(mailboxAddressValue)
  if (!mailboxAddress) return { allowed: false, error: checkError(direction) }
  const domain = mailboxDomain(mailboxAddress)
  if (!isDomainOperationAllowed(access, domain, direction)) {
    return { allowed: false, error: domainError(direction) }
  }

  const now = Date.now()
  const reservationExpiresAt = now + RESERVATION_LEASE_MILLISECONDS
  const subject = quotaSubject(userId, access, direction)
  const role = mailQuotaRoleForDirection(access, direction)
  const id = randomUUID()
  const finalizeReservation = (snapshot: MailQuotaSnapshot): MailPermissionResult & { reservation?: MailQuotaReservation } => {
    const error = quotaError(snapshot)
    if (error) return { allowed: false, error, quota: snapshot }
    const reserved: MailQuotaSnapshot = {
      ...snapshot,
      total: counter(snapshot.total.rule, { completed: snapshot.total.completed, pending: snapshot.total.pending + 1 }),
      domain: snapshot.domain ? {
        domain: snapshot.domain.domain,
        ...counter(snapshot.domain.rule, { completed: snapshot.domain.completed, pending: snapshot.domain.pending + 1 }),
      } : undefined,
      mailbox: snapshot.mailbox ? mailboxCounter(
        mailboxAddress,
        snapshot.mailbox.rule,
        { completed: snapshot.mailbox.rolling.completed, pending: snapshot.mailbox.rolling.pending + 1 },
        { completed: snapshot.mailbox.lifetimeCompleted, pending: snapshot.mailbox.lifetimePending + 1 },
      ) : undefined,
    }
    return {
      allowed: true,
      quota: reserved,
      remaining: reserved.total.remaining ?? undefined,
      reservation: { id, direction, userId, subject, domain, mailboxAddress, createdAt: new Date(now), expiresAt: new Date(reservationExpiresAt) },
    }
  }

  const reserve = async (read: Parameters<typeof snapshotWithCounter>[4], insert: () => void | Promise<void>) => {
    const snapshot = await snapshotWithCounter(userId, mailboxAddress, access, direction, read)
    const prepared = finalizeReservation(snapshot)
    if (!prepared.allowed) return prepared
    await insert()
    return prepared
  }

  if (activeDriver() === "sqlite") {
    return sqliteHandle().transaction(() => {
      const policy = mailQuotaForDirection(access, direction)
      const domainRule = mailQuotaRuleForDomain(access, direction, domain)
      const mailboxRule = mailboxQuotaRuleForAddress(access, direction, mailboxAddress)
      const snapshot: MailQuotaSnapshot = {
        direction,
        subject,
        scope: policy.scope,
        role,
        total: counter(policy.total, sqliteCounter(subject, userId, direction, null, null, policy.total, now)),
        domain: { domain, ...counter(domainRule, sqliteCounter(subject, userId, direction, domain, null, domainRule, now)) },
        mailbox: mailboxCounter(
          mailboxAddress,
          mailboxRule,
          sqliteCounter(subject, userId, direction, null, mailboxAddress, mailboxRule.rolling, now),
          sqliteCounter(subject, userId, direction, null, mailboxAddress, null, now),
        ),
      }
      const result = finalizeReservation(snapshot)
      if (!result.allowed) return result
      sqliteHandle().prepare(`
        INSERT INTO send_quota_event
          (id, user_id, quota_subject, policy_role, direction, sender_domain, mailbox_address, status, created_at, reservation_expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)
      `).run(id, userId, subject, role, direction, domain, mailboxAddress, now, reservationExpiresAt)
      return result
    }).immediate()
  }

  const client = await getPostgresPool().connect()
  try {
    await client.query("BEGIN")
    // Serialize the complete aggregate budget. Locking per mailbox would let
    // concurrent reservations for different addresses oversubscribe a shared
    // total or per-domain limit.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${subject}:${direction}`])
    const query = client.query.bind(client) as unknown as Query
    const result = await reserve(
      (readDomain, readMailbox, rule) => postgresCounter(query, subject, userId, direction, readDomain, readMailbox, rule, now),
      async () => { await client.query(`
        INSERT INTO send_quota_event
          (id, user_id, quota_subject, policy_role, direction, sender_domain, mailbox_address, status, created_at, reservation_expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved', $8, $9)
      `, [id, userId, subject, role, direction, domain, mailboxAddress, new Date(now), new Date(reservationExpiresAt)]) },
    )
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
): Promise<SendPermissionResult & { reservation?: SendQuotaReservation }> {
  const address = senderAddressOrDomain.includes("@")
    ? senderAddressOrDomain
    : `__quota__@${senderAddressOrDomain}`
  const result = await reserveMailQuota(userId, address, "send", resolvedAccess)
  return {
    canSend: result.allowed,
    error: result.error,
    quota: result.quota ? sendSnapshot(result.quota) : undefined,
    remainingEmails: result.remaining,
    reservation: result.reservation,
  }
}

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

/**
 * Rolls back a quota charge only after the outbound transport has returned a
 * definite failure. Callers intentionally complete outbound reservations
 * before handing the message to an external provider: if the process exits
 * while the provider outcome is unknown, the attempt remains charged instead
 * of becoming a quota-bypass window when a short reservation lease expires.
 */
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

type UsageFilter = { column: "quota_subject" | "policy_role" | "user_id"; value: string }

async function usageCounter(
  filter: UsageFilter,
  direction: MailDirection,
  domain: string | null,
  rule: MailQuotaRule,
  now: number,
): Promise<Counter & { allTimeCompleted: number }> {
  const cutoff = cutoffMilliseconds(now, rule)
  if (activeDriver() === "sqlite") {
    const domainClause = domain === null ? "" : " AND sender_domain = ?"
    const row = sqliteHandle().prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END), 0) AS all_time,
        COALESCE(SUM(CASE WHEN status = 'sent' AND created_at >= ? THEN 1 ELSE 0 END), 0) AS completed,
        COALESCE(SUM(CASE WHEN status = 'reserved' AND created_at >= ? AND reservation_expires_at > ? THEN 1 ELSE 0 END), 0) AS pending
      FROM send_quota_event
      WHERE ${filter.column} = ? AND direction = ?${domainClause}
    `).get(cutoff, cutoff, now, filter.value, direction, ...(domain === null ? [] : [domain])) as {
      all_time: number; completed: number; pending: number
    }
    return { allTimeCompleted: Number(row.all_time), completed: Number(row.completed), pending: Number(row.pending) }
  }
  const domainClause = domain === null ? "" : " AND sender_domain = $5"
  const result = await getPostgresPool().query<{
    all_time: string; completed: string; pending: string
  }>(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'sent') AS all_time,
      COUNT(*) FILTER (WHERE status = 'sent' AND created_at >= $3) AS completed,
      COUNT(*) FILTER (WHERE status = 'reserved' AND created_at >= $3 AND reservation_expires_at > $4) AS pending
    FROM send_quota_event
    WHERE ${filter.column} = $1 AND direction = $2${domainClause}
  `, [filter.value, direction, new Date(cutoff), new Date(now), ...(domain === null ? [] : [domain])])
  return {
    allTimeCompleted: Number(result.rows[0]?.all_time ?? 0),
    completed: Number(result.rows[0]?.completed ?? 0),
    pending: Number(result.rows[0]?.pending ?? 0),
  }
}

async function usageDomains(filter: UsageFilter, direction: MailDirection): Promise<string[]> {
  if (activeDriver() === "sqlite") {
    const rows = sqliteHandle().prepare(`
      SELECT DISTINCT sender_domain AS domain FROM send_quota_event
      WHERE ${filter.column} = ? AND direction = ? AND status = 'sent' ORDER BY sender_domain
    `).all(filter.value, direction) as Array<{ domain: string }>
    return rows.map(row => row.domain)
  }
  const result = await getPostgresPool().query<{ domain: string }>(`
    SELECT DISTINCT sender_domain AS domain FROM send_quota_event
    WHERE ${filter.column} = $1 AND direction = $2 AND status = 'sent' ORDER BY sender_domain
  `, [filter.value, direction])
  return result.rows.map(row => row.domain)
}

function sameFilter(left: UsageFilter, right: UsageFilter) {
  return left.column === right.column && left.value === right.value
}

async function buildUsage(
  target: MailQuotaUsage["target"],
  access: EffectiveAccessPolicy,
  direction: MailDirection,
  quotaFilter: UsageFilter,
  auditFilter: UsageFilter,
  aggregate: boolean,
): Promise<MailQuotaUsage> {
  const policy = mailQuotaForDirection(access, direction)
  const role = mailQuotaRoleForDirection(access, direction)
  const now = Date.now()
  const totalUsage = await usageCounter(quotaFilter, direction, null, policy.total, now)
  const auditUsage = sameFilter(quotaFilter, auditFilter)
    ? totalUsage
    : await usageCounter(auditFilter, direction, null, policy.total, now)
  const domains = await Promise.all([...new Set([
    ...Object.keys(policy.domains),
    ...await usageDomains(auditFilter, direction),
  ])].sort().map(async domain => {
    const rule = mailQuotaRuleForDomain(access, direction, domain)
    const usage = await usageCounter(quotaFilter, direction, domain, rule, now)
    const audit = sameFilter(quotaFilter, auditFilter)
      ? usage
      : await usageCounter(auditFilter, direction, domain, rule, now)
    return {
      domain,
      allTimeCompleted: audit.allTimeCompleted,
      ...counter(rule, usage),
      ...(aggregate ? { remaining: null } : {}),
    }
  }))
  return {
    direction,
    target,
    scope: policy.scope,
    role,
    aggregate,
    allTimeCompleted: auditUsage.allTimeCompleted,
    total: { ...counter(policy.total, totalUsage), ...(aggregate ? { remaining: null } : {}) },
    domains,
  }
}

export function getRoleMailQuotaUsage(
  role: EffectiveAccessPolicy["sendQuotaRole"],
  access: EffectiveAccessPolicy,
  direction: MailDirection,
) {
  const policy = mailQuotaForDirection(access, direction)
  const aggregate = policy.scope === "user"
  return buildUsage(
    { type: "role", id: role },
    access,
    direction,
    aggregate ? { column: "policy_role", value: role } : { column: "quota_subject", value: `role:${role}` },
    { column: "policy_role", value: role },
    aggregate,
  )
}

export function getUserMailQuotaUsage(
  userId: string,
  access: EffectiveAccessPolicy,
  direction: MailDirection,
) {
  return buildUsage(
    { type: "user", id: userId },
    access,
    direction,
    { column: "quota_subject", value: quotaSubject(userId, access, direction) },
    { column: "user_id", value: userId },
    false,
  )
}

function toSendUsage(value: MailQuotaUsage): SendQuotaUsage {
  return {
    target: value.target,
    scope: value.scope,
    role: value.role,
    aggregate: value.aggregate,
    allTimeSent: value.allTimeCompleted,
    total: sendCounter(value.total),
    domains: value.domains.map(domain => ({
      ...sendCounter(domain),
      domain: domain.domain,
      allTimeSent: domain.allTimeCompleted,
    })),
  }
}

export async function getRoleSendQuotaUsage(
  role: EffectiveAccessPolicy["sendQuotaRole"],
  access: EffectiveAccessPolicy,
) {
  return toSendUsage(await getRoleMailQuotaUsage(role, access, "send"))
}

export async function getUserSendQuotaUsage(userId: string, access: EffectiveAccessPolicy) {
  return toSendUsage(await getUserMailQuotaUsage(userId, access, "send"))
}

export async function resetMailQuotaUsage(input: {
  direction: MailDirection
  userId?: string
  role?: EffectiveAccessPolicy["sendQuotaRole"]
  mailboxAddress?: string
}) {
  const address = input.mailboxAddress == null ? null : normalizeMailboxAddress(input.mailboxAddress)
  if (input.mailboxAddress != null && !address) throw new Error("INVALID_MAILBOX_ADDRESS")
  if (!input.userId && !input.role) throw new Error("QUOTA_RESET_TARGET_REQUIRED")
  const conditions = ["direction = ?"]
  const sqliteValues: string[] = [input.direction]
  // A user reset is exact. A role reset intentionally removes every event
  // recorded while that role policy was active, regardless of user/role scope.
  if (input.userId) { conditions.push("user_id = ?"); sqliteValues.push(input.userId) }
  else if (input.role) { conditions.push("policy_role = ?"); sqliteValues.push(input.role) }
  if (address) { conditions.push("mailbox_address = ?"); sqliteValues.push(address) }
  if (activeDriver() === "sqlite") {
    return sqliteHandle().prepare(`DELETE FROM send_quota_event WHERE ${conditions.join(" AND ")}`).run(...sqliteValues).changes
  }
  const pgValues = sqliteValues
  const pgConditions = conditions.map((condition, index) => condition.replace("?", `$${index + 1}`))
  const result = await getPostgresPool().query(`DELETE FROM send_quota_event WHERE ${pgConditions.join(" AND ")}`, pgValues)
  return result.rowCount ?? 0
}
