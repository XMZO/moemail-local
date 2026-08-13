import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import Database from "better-sqlite3"
import type { MailQuotaSubject, MailQuotaTarget } from "../../app/lib/access-policies"

const sandbox = mkdtempSync(join(tmpdir(), "moemail-send-quota-"))
const previousCwd = process.cwd()
let sqlite: InstanceType<typeof Database> | undefined

try {
  process.chdir(sandbox)
  mkdirSync(join(sandbox, "data"), { recursive: true })
  sqlite = new Database(join(sandbox, "data", "quota.db"))
  sqlite.exec(`
    CREATE TABLE user (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE send_quota_event (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT,
      quota_subject TEXT NOT NULL,
      policy_role TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT 'send',
      sender_domain TEXT NOT NULL,
      mailbox_address TEXT NOT NULL DEFAULT '',
      global_rule_id TEXT,
      scoped_rule_id TEXT,
      status TEXT NOT NULL DEFAULT 'reserved',
      created_at INTEGER NOT NULL,
      reservation_expires_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE SET NULL,
      CHECK (status IN ('reserved', 'sent')),
      CHECK (policy_role IN ('emperor', 'duke', 'knight', 'civilian'))
    );
    CREATE INDEX quota_user ON send_quota_event(user_id, direction, created_at);
    CREATE INDEX quota_role ON send_quota_event(policy_role, direction, created_at);
  `)
  for (const id of ["user-a", "user-b", "owner"]) sqlite.prepare("INSERT INTO user (id) VALUES (?)").run(id)

  const policy = await import("../../app/lib/access-policies")
  const quota = await import("../../app/lib/send-permissions")
  quota.setSendQuotaDatabaseForValidation(sqlite)

  const policies = policy.createDefaultAccessPolicies()
  const add = (
    direction: "send" | "receive",
    subject: MailQuotaSubject,
    target: MailQuotaTarget,
    limit: number,
    lifetimeLimit = -1,
    options: { shareWithinRole?: boolean; ignoreEmperor?: boolean } = {},
  ) => policies.mailQuotaRules.push({
    id: randomUUID(),
    direction,
    subject,
    target,
    rolling: { limit, windowValue: 1, windowUnit: "hour" },
    lifetimeLimit,
    shareWithinRole: options.shareWithinRole ?? false,
    ignoreEmperor: options.ignoreEmperor ?? false,
  })

  // Remove defaults so this fixture only contains rules under test.
  policies.mailQuotaRules = []
  add("send", { type: "all" }, { type: "all" }, 7, -1, { ignoreEmperor: true })
  add("send", { type: "role", role: "duke" }, { type: "all" }, 3)
  add("send", { type: "role", role: "duke" }, { type: "domain", domain: "tight.example" }, 2, -1, { shareWithinRole: true })
  add("send", { type: "user", userId: "user-a" }, { type: "all" }, 4)
  add("send", { type: "user", userId: "user-a" }, { type: "mailbox", address: "exact@tight.example" }, 1, 2)
  add("receive", { type: "role", role: "duke" }, { type: "mailbox", address: "persist@example.test" }, 2, 3)

  const userA = policy.resolveAccessPolicy(policies, "user-a", ["duke"])
  const userB = policy.resolveAccessPolicy(policies, "user-b", ["duke"])
  const owner = policy.resolveAccessPolicy(policies, "owner", ["emperor"])

  // Subject specificity wins before target specificity: an explicit user-wide
  // rule intentionally overrides role-domain rules.
  assert.equal(policy.resolveMailQuotaAssignment(userA, "send", "box@tight.example")?.rolling.limit, 4)
  assert.equal(policy.resolveMailQuotaAssignment(userB, "send", "box@tight.example")?.rolling.limit, 2)
  assert.equal(policy.resolveMailQuotaAssignment(userA, "send", "exact@tight.example")?.rolling.limit, 1)
  assert.equal(policy.resolveMailQuotaAssignment(owner, "send", "owner@tight.example"), undefined)
  assert.deepEqual(policy.resolveMailQuotaAssignments(userA, "send", "box@tight.example").map(rule => rule.rolling.limit), [7, 4])

  const includeOwnerPolicies = policy.createDefaultAccessPolicies()
  includeOwnerPolicies.mailQuotaRules = []
  const includeOwner = (
    direction: "send" | "receive",
    subject: MailQuotaSubject,
    target: MailQuotaTarget,
    limit: number,
    lifetimeLimit = -1,
    options: { shareWithinRole?: boolean; ignoreEmperor?: boolean } = {},
  ) => includeOwnerPolicies.mailQuotaRules.push({ id: randomUUID(), direction, subject, target, rolling: { limit, windowValue: 1, windowUnit: "hour" }, lifetimeLimit, shareWithinRole: options.shareWithinRole ?? false, ignoreEmperor: options.ignoreEmperor ?? false })
  includeOwner("send", { type: "all" }, { type: "all" }, 1)
  const ownerInGlobalPool = policy.resolveAccessPolicy(includeOwnerPolicies, "owner", ["emperor"])
  assert.equal(policy.resolveMailQuotaAssignments(ownerInGlobalPool, "send", "owner@tight.example").length, 1)
  const ownerFirst = await quota.reserveSendQuota("owner", "owner@tight.example", ownerInGlobalPool)
  assert(ownerFirst.canSend && ownerFirst.reservation)
  await quota.completeSendQuotaReservation(ownerFirst.reservation)
  assert.equal((await quota.reserveSendQuota("user-b", "box@other.example", policy.resolveAccessPolicy(includeOwnerPolicies, "user-b", ["duke"]))).error, "SEND_GLOBAL_QUOTA_EXCEEDED")
  sqlite.prepare("DELETE FROM send_quota_event").run()

  const sharedRoleOnlyPolicies = policy.createDefaultAccessPolicies()
  sharedRoleOnlyPolicies.mailQuotaRules = []
  const sharedRoleOnly = (
    direction: "send" | "receive",
    subject: MailQuotaSubject,
    target: MailQuotaTarget,
    limit: number,
    lifetimeLimit = -1,
    options: { shareWithinRole?: boolean; ignoreEmperor?: boolean } = {},
  ) => sharedRoleOnlyPolicies.mailQuotaRules.push({ id: randomUUID(), direction, subject, target, rolling: { limit, windowValue: 1, windowUnit: "hour" }, lifetimeLimit, shareWithinRole: options.shareWithinRole ?? false, ignoreEmperor: options.ignoreEmperor ?? false })
  sharedRoleOnly("send", { type: "role", role: "duke" }, { type: "all" }, 1, -1, { shareWithinRole: true })
  const sharedA = policy.resolveAccessPolicy(sharedRoleOnlyPolicies, "user-a", ["duke"])
  const sharedB = policy.resolveAccessPolicy(sharedRoleOnlyPolicies, "user-b", ["duke"])
  const sharedFirst = await quota.reserveSendQuota("user-a", "box@other.example", sharedA)
  assert(sharedFirst.canSend && sharedFirst.reservation)
  await quota.completeSendQuotaReservation(sharedFirst.reservation)
  assert.equal((await quota.reserveSendQuota("user-b", "box@other.example", sharedB)).error, "SEND_TOTAL_QUOTA_EXCEEDED")
  sqlite.prepare("DELETE FROM send_quota_event").run()

  const atomic = await quota.reserveSendQuota("user-a", "box@other.example", userA, 3)
  assert(atomic.canSend && atomic.reservations?.length === 3)
  assert.equal(atomic.quota?.applied.at(-1)?.rolling.pending, 3)
  await quota.completeSendQuotaReservations(atomic.reservations)
  assert.equal((await quota.reserveSendQuota("user-a", "box@other.example", userA, 2)).error, "SEND_TOTAL_QUOTA_EXCEEDED")
  const last = await quota.reserveSendQuota("user-a", "box@other.example", userA)
  assert(last.canSend && last.reservation)
  await quota.completeSendQuotaReservation(last.reservation)

  // The role-domain pool is shared. User B consumes it first.
  const bOne = await quota.reserveSendQuota("user-b", "box@tight.example", userB, 2)
  assert(bOne.canSend && bOne.reservations)
  await quota.completeSendQuotaReservations(bOne.reservations)
  assert.equal((await quota.reserveSendQuota("user-b", "box@tight.example", userB)).error, "SEND_DOMAIN_QUOTA_EXCEEDED")
  assert.equal((await quota.checkSendPermission("user-b", "box@other.example", userB)).canSend, true)

  const fillGlobal = await quota.reserveSendQuota("user-b", "box@other.example", userB)
  assert(fillGlobal.canSend && fillGlobal.reservation)
  await quota.completeSendQuotaReservation(fillGlobal.reservation)

  // A user-specific rule overrides the role rule, but the site-wide shared
  // pool still applies and is exhausted by both users together.
  assert.equal((await quota.reserveSendQuota("user-a", "box@tight.example", userA)).error, "SEND_GLOBAL_QUOTA_EXCEEDED")
  sqlite.prepare("DELETE FROM send_quota_event WHERE direction = 'send'").run()

  const exactOne = await quota.reserveSendQuota("user-a", "exact@tight.example", userA)
  assert(exactOne.canSend && exactOne.reservation)
  await quota.completeSendQuotaReservation(exactOne.reservation)
  assert.equal((await quota.reserveSendQuota("user-a", "exact@tight.example", userA)).error, "SEND_MAILBOX_QUOTA_EXCEEDED")
  // The exact-mailbox event belongs only to the exact rule. It must not be
  // retroactively charged to the user's lower-priority all-address rule.
  const otherAddress = await quota.checkSendPermission("user-a", "box@other.example", userA)
  assert.equal(otherAddress.canSend, true)
  assert.equal(otherAddress.quota?.applied.at(-1)?.rolling.completed, 0)
  sqlite.prepare("UPDATE send_quota_event SET created_at = ? WHERE id = ?")
    .run(Date.now() - 2 * 60 * 60_000, exactOne.reservation.id)
  const exactAfterWindow = await quota.checkSendPermission("user-a", "exact@tight.example", userA)
  assert.equal(exactAfterWindow.canSend, true)
  assert.equal(exactAfterWindow.remainingEmails, 1)

  const receiveOne = await quota.reserveMailQuota("user-a", "persist@example.test", "receive", userA)
  const receiveTwo = await quota.reserveMailQuota("user-a", "persist@example.test", "receive", userA)
  assert(receiveOne.allowed && receiveOne.reservation && receiveTwo.allowed && receiveTwo.reservation)
  await quota.completeMailQuotaReservations([receiveOne.reservation, receiveTwo.reservation])
  assert.equal((await quota.reserveMailQuota("user-a", "persist@example.test", "receive", userA)).error, "RECEIVE_MAILBOX_QUOTA_EXCEEDED")
  sqlite.prepare("UPDATE send_quota_event SET created_at = ? WHERE user_id = ? AND direction = 'receive'")
    .run(Date.now() - 2 * 60 * 60_000, "user-a")
  const receiveThree = await quota.reserveMailQuota("user-a", "persist@example.test", "receive", userA)
  assert(receiveThree.allowed && receiveThree.reservation)
  await quota.completeMailQuotaReservation(receiveThree.reservation)
  assert.equal((await quota.reserveMailQuota("user-a", "persist@example.test", "receive", userA)).error, "RECEIVE_MAILBOX_LIFETIME_QUOTA_EXCEEDED")

  const userUsage = await quota.getUserMailQuotaUsage("user-a", userA, "send")
  assert.equal(userUsage.aggregate, false)
  assert.equal(userUsage.allTimeCompleted, 1)
  assert.equal(userUsage.rules.length, 3)
  const roleUsage = await quota.getRoleMailQuotaUsage("duke", userB, "send")
  assert.equal(roleUsage.aggregate, true)
  assert.equal(roleUsage.allTimeCompleted, 1)

  const globalUsage = await quota.getGlobalMailQuotaUsage(userB, "send")
  assert.equal(globalUsage.target.type, "all")
  assert.equal(globalUsage.allTimeCompleted, 1)
  assert.equal(globalUsage.rules.length, 1)

  const pendingBeforeReset = await quota.reserveSendQuota("user-b", "box@other.example", userB)
  assert(pendingBeforeReset.canSend && pendingBeforeReset.reservation)
  assert.equal(await quota.resetMailQuotaUsage({ direction: "send", all: true }), 1)
  const rowsAfterGlobalReset = sqlite.prepare(`
    SELECT status, COUNT(*) AS count FROM send_quota_event
    WHERE direction = 'send' GROUP BY status ORDER BY status
  `).all() as Array<{ status: string; count: number }>
  assert.deepEqual(rowsAfterGlobalReset, [{ status: "reserved", count: 1 }])
  await quota.releaseSendQuotaReservation(pendingBeforeReset.reservation)

  sqlite.prepare(`
    INSERT INTO send_quota_event
      (id, user_id, quota_subject, policy_role, direction, sender_domain, mailbox_address, status, created_at, reservation_expires_at, completed_at)
    VALUES ('legacy-unassigned', 'user-b', 'user:user-b', 'duke', 'send', 'other.example', 'box@other.example', 'sent', ?, ?, ?)
  `).run(Date.now(), Date.now(), Date.now())
  assert.equal(await quota.resetMailQuotaUsage({ direction: "send", all: true }), 0)
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM send_quota_event WHERE id = 'legacy-unassigned'").get() as { count: number }).count, 1)
  assert.equal((await quota.getGlobalMailQuotaUsage(userB, "send")).allTimeCompleted, 0)
  sqlite.prepare("DELETE FROM send_quota_event WHERE id = 'legacy-unassigned'").run()

  assert.equal(await quota.resetMailQuotaUsage({ direction: "receive", userId: "user-a", mailboxAddress: "persist@example.test" }), 3)
  assert.equal((await quota.checkMailPermission("user-a", "persist@example.test", "receive", userA)).allowed, true)
  assert.equal((await quota.checkSendPermission("owner", "owner@tight.example", owner)).canSend, true)

  console.log(JSON.stringify({
    subjectPrecedence: true,
    targetPrecedence: true,
    globalPoolStacksWithScopedRule: true,
    oneRulePerLayer: true,
    sharedRolePool: true,
    atomicMultiRecipientReservation: true,
    independentUserCounters: true,
    rollingAndLifetimeMailboxQuota: true,
    historicalRuleIdentity: true,
    lifetimeIncludedInRemaining: true,
    emperorExcludedFromAllSubject: true,
    globalUsageAndSafeReset: true,
  }))
  quota.setSendQuotaDatabaseForValidation()
} finally {
  sqlite?.close()
  process.chdir(previousCwd)
  try {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EPERM" && process.platform === "win32")) throw error
  }
}
