import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"

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
      status TEXT NOT NULL DEFAULT 'reserved',
      created_at INTEGER NOT NULL,
      reservation_expires_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE SET NULL,
      CHECK (status IN ('reserved', 'sent')),
      CHECK (policy_role IN ('emperor', 'duke', 'knight', 'civilian'))
    );
    CREATE INDEX send_quota_event_subject_created_idx ON send_quota_event(quota_subject, created_at);
    CREATE INDEX send_quota_event_subject_domain_created_idx ON send_quota_event(quota_subject, sender_domain, created_at);
    CREATE INDEX send_quota_event_user_created_idx ON send_quota_event(user_id, created_at);
    CREATE INDEX send_quota_event_role_created_idx ON send_quota_event(policy_role, created_at);
  `)
  sqlite.prepare("INSERT INTO user (id) VALUES (?)").run("user-a")
  sqlite.prepare("INSERT INTO user (id) VALUES (?)").run("user-b")
  sqlite.prepare("INSERT INTO user (id) VALUES (?)").run("user-c")

  const { createDefaultAccessPolicies, resolveAccessPolicy } = await import("../../app/lib/access-policies")
  const quota = await import("../../app/lib/send-permissions")
  quota.setSendQuotaDatabaseForValidation(sqlite)
  const {
    checkSendPermission,
    checkMailPermission,
    completeSendQuotaReservation,
    completeMailQuotaReservation,
    resetMailQuotaUsage,
    getRoleSendQuotaUsage,
    getUserSendQuotaUsage,
    releaseSendQuotaReservation,
    reserveSendQuota,
    reserveMailQuota,
  } = quota

  const policies = createDefaultAccessPolicies()
  policies.roles.duke.sendQuota = {
    scope: "role",
    total: { limit: 3, windowValue: 1, windowUnit: "hour" },
    domains: {
      "alpha.example": { limit: 2, windowValue: 1, windowUnit: "hour" },
      "blocked.example": { limit: 0, windowValue: 1, windowUnit: "hour" },
    },
    mailbox: { rolling: { limit: -1, windowValue: 1, windowUnit: "day" }, lifetimeLimit: -1 },
    domainMailboxes: {},
    mailboxes: {},
  }
  const roleAccessA = resolveAccessPolicy(policies, "user-a", ["duke"])
  const roleAccessB = resolveAccessPolicy(policies, "user-b", ["duke"])

  const blocked = await reserveSendQuota("user-a", "blocked.example", roleAccessA)
  assert.equal(blocked.canSend, false)
  assert.equal(blocked.error, "SEND_DOMAIN_QUOTA_EXCEEDED")

  const first = await reserveSendQuota("user-a", "alpha.example", roleAccessA)
  assert(first.canSend && first.reservation)
  const second = await reserveSendQuota("user-b", "alpha.example", roleAccessB)
  assert(second.canSend && second.reservation)
  const concurrentOverflow = await reserveSendQuota("user-a", "alpha.example", roleAccessA)
  assert.equal(concurrentOverflow.canSend, false)
  assert.equal(concurrentOverflow.error, "SEND_DOMAIN_QUOTA_EXCEEDED")

  await completeSendQuotaReservation(first.reservation)
  await releaseSendQuotaReservation(second.reservation)
  const releasedSlot = await reserveSendQuota("user-b", "alpha.example", roleAccessB)
  assert(releasedSlot.canSend && releasedSlot.reservation)
  await completeSendQuotaReservation(releasedSlot.reservation)

  const thirdDomain = await reserveSendQuota("user-a", "gamma.example", roleAccessA)
  assert(thirdDomain.canSend && thirdDomain.reservation)
  await completeSendQuotaReservation(thirdDomain.reservation)
  const totalOverflow = await reserveSendQuota("user-b", "gamma.example", roleAccessB)
  assert.equal(totalOverflow.canSend, false)
  assert.equal(totalOverflow.error, "SEND_TOTAL_QUOTA_EXCEEDED")

  const roleUsage = await getRoleSendQuotaUsage("duke", roleAccessA)
  assert.equal(roleUsage.scope, "role")
  assert.equal(roleUsage.allTimeSent, 3)
  assert.equal(roleUsage.total.sent, 3)
  assert.equal(roleUsage.domains.find(item => item.domain === "alpha.example")?.sent, 2)

  policies.users["user-b"] = {
    permissions: {},
    quotas: {},
    sendQuota: {
      total: { limit: -1, windowValue: 1, windowUnit: "minute" },
      domains: {
        "alpha.example": { limit: 1, windowValue: 1, windowUnit: "minute" },
      },
    },
  }
  const userAccess = resolveAccessPolicy(policies, "user-b", ["duke"])
  assert.equal(userAccess.sendQuota.scope, "user")
  const individual = await reserveSendQuota("user-b", "alpha.example", userAccess)
  assert(individual.canSend && individual.reservation)
  await completeSendQuotaReservation(individual.reservation)
  const individualOverflow = await checkSendPermission("user-b", "alpha.example", userAccess)
  assert.equal(individualOverflow.canSend, false)
  assert.equal(individualOverflow.error, "SEND_DOMAIN_QUOTA_EXCEEDED")
  const unrestrictedDomain = await checkSendPermission("user-b", "gamma.example", userAccess)
  assert.equal(unrestrictedDomain.canSend, true)

  policies.roles.duke.receiveQuota.scope = "role"
  policies.users["user-c"] = {
    permissions: {},
    quotas: {},
    receiveQuota: {
      mailbox: {
        rolling: { limit: 1, windowValue: 1, windowUnit: "hour" },
        lifetimeLimit: 2,
      },
      domainMailboxes: {
        "mailbox-only.example": {
          rolling: { limit: 1, windowValue: 1, windowUnit: "hour" },
          lifetimeLimit: 2,
        },
      },
      mailboxes: {
        "exact@mailbox-only.example": {
          rolling: { limit: 1, windowValue: 1, windowUnit: "hour" },
          lifetimeLimit: 2,
        },
      },
    },
  }
  const mailboxOnlyOverride = resolveAccessPolicy(policies, "user-c", ["duke"])
  assert.equal(mailboxOnlyOverride.receiveQuota.scope, "role")

  policies.users["user-c"] = {
    permissions: {},
    quotas: {},
    sendQuota: {
      total: { limit: 1, windowValue: 1, windowUnit: "month" },
      domains: {},
    },
  }
  const crashRecoveryAccess = resolveAccessPolicy(policies, "user-c", ["duke"])
  sqlite.prepare(`
    INSERT INTO send_quota_event
      (id, user_id, quota_subject, policy_role, sender_domain, status, created_at, reservation_expires_at)
    VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)
  `).run(
    "expired-reservation",
    "user-c",
    "user:user-c",
    "duke",
    "gamma.example",
    Date.now(),
    Date.now() - 1,
  )
  const recoveredAfterCrash = await reserveSendQuota("user-c", "gamma.example", crashRecoveryAccess)
  assert(recoveredAfterCrash.canSend && recoveredAfterCrash.reservation)
  await releaseSendQuotaReservation(recoveredAfterCrash.reservation)

  const userUsage = await getUserSendQuotaUsage("user-b", userAccess)
  assert.equal(userUsage.allTimeSent, 2)
  assert.equal(userUsage.domains[0]?.sent, 1)

  const sharedUserUsage = await getUserSendQuotaUsage("user-a", roleAccessA)
  assert.equal(sharedUserUsage.scope, "role")
  assert.equal(sharedUserUsage.allTimeSent, 2)
  assert.equal(sharedUserUsage.total.sent, 3)
  assert.equal(
    sharedUserUsage.domains.find(item => item.domain === "gamma.example")?.allTimeSent,
    1,
  )

  const mailboxPolicies = createDefaultAccessPolicies()
  mailboxPolicies.roles.duke.receiveQuota = {
    scope: "role",
    total: { limit: -1, windowValue: 1, windowUnit: "day" },
    domains: {},
    mailbox: {
      rolling: { limit: 2, windowValue: 1, windowUnit: "hour" },
      lifetimeLimit: 3,
    },
    domainMailboxes: {
      "tight.example": {
        rolling: { limit: 1, windowValue: 1, windowUnit: "hour" },
        lifetimeLimit: 2,
      },
    },
    mailboxes: {
      "exact@tight.example": {
        rolling: { limit: 2, windowValue: 1, windowUnit: "hour" },
        lifetimeLimit: 4,
      },
    },
  }
  mailboxPolicies.roles.duke.domainAccess = {
    default: "allow",
    domains: { "send-only.example": "send", "receive-only.example": "receive" },
  }
  const mailboxAccessA = resolveAccessPolicy(mailboxPolicies, "user-a", ["duke"])
  const mailboxAccessC = resolveAccessPolicy(mailboxPolicies, "user-c", ["duke"])

  assert.equal((await checkMailPermission("user-a", "box@send-only.example", "receive", mailboxAccessA)).error, "MAIL_DOMAIN_RECEIVE_FORBIDDEN")
  assert.equal((await checkMailPermission("user-a", "box@send-only.example", "send", mailboxAccessA)).allowed, true)
  assert.equal((await checkMailPermission("user-a", "box@receive-only.example", "send", mailboxAccessA)).error, "MAIL_DOMAIN_SEND_FORBIDDEN")

  const receiveOne = await reserveMailQuota("user-a", "persist@example.test", "receive", mailboxAccessA)
  assert(receiveOne.allowed && receiveOne.reservation)
  await completeMailQuotaReservation(receiveOne.reservation)
  const receiveTwo = await reserveMailQuota("user-a", "persist@example.test", "receive", mailboxAccessA)
  assert(receiveTwo.allowed && receiveTwo.reservation)
  await completeMailQuotaReservation(receiveTwo.reservation)
  const rollingBlocked = await reserveMailQuota("user-a", "persist@example.test", "receive", mailboxAccessA)
  assert.equal(rollingBlocked.error, "RECEIVE_MAILBOX_QUOTA_EXCEEDED")

  // Moving completed events outside the rolling window models time passing (or
  // deleting and recreating the mailbox). Lifetime history must still apply.
  sqlite.prepare(`UPDATE send_quota_event SET created_at = ? WHERE user_id = ? AND mailbox_address = ? AND direction = 'receive'`)
    .run(Date.now() - 2 * 60 * 60_000, "user-a", "persist@example.test")
  const receiveThree = await reserveMailQuota("user-a", "persist@example.test", "receive", mailboxAccessA)
  assert(receiveThree.allowed && receiveThree.reservation)
  await completeMailQuotaReservation(receiveThree.reservation)
  const lifetimeBlocked = await reserveMailQuota("user-a", "persist@example.test", "receive", mailboxAccessA)
  assert.equal(lifetimeBlocked.error, "RECEIVE_MAILBOX_LIFETIME_QUOTA_EXCEEDED")

  // A role aggregate may be shared, but mailbox counters are per concrete user.
  const otherRoleMember = await reserveMailQuota("user-c", "persist@example.test", "receive", mailboxAccessC)
  assert(otherRoleMember.allowed && otherRoleMember.reservation)
  await completeMailQuotaReservation(otherRoleMember.reservation)

  const tightOne = await reserveMailQuota("user-a", "one@tight.example", "receive", mailboxAccessA)
  assert(tightOne.allowed && tightOne.reservation)
  await completeMailQuotaReservation(tightOne.reservation)
  assert.equal((await reserveMailQuota("user-a", "one@tight.example", "receive", mailboxAccessA)).error, "RECEIVE_MAILBOX_QUOTA_EXCEEDED")
  const exactOne = await reserveMailQuota("user-a", "exact@tight.example", "receive", mailboxAccessA)
  assert(exactOne.allowed && exactOne.reservation)
  await completeMailQuotaReservation(exactOne.reservation)
  const exactTwo = await reserveMailQuota("user-a", "exact@tight.example", "receive", mailboxAccessA)
  assert(exactTwo.allowed && exactTwo.reservation)
  await completeMailQuotaReservation(exactTwo.reservation)

  const resetCount = await resetMailQuotaUsage({ direction: "receive", userId: "user-a", mailboxAddress: "persist@example.test" })
  assert.equal(resetCount, 3)
  assert.equal((await checkMailPermission("user-a", "persist@example.test", "receive", mailboxAccessA)).allowed, true)

  sqlite.prepare("DELETE FROM user WHERE id = ?").run("user-b")
  assert.equal(
    Number((sqlite.prepare("SELECT COUNT(*) AS count FROM send_quota_event WHERE user_id IS NULL").get() as { count: number }).count),
    2,
  )
  assert.equal(
    Number((sqlite.prepare("SELECT COUNT(*) AS count FROM send_quota_event WHERE status = 'sent' AND direction = 'send'").get() as { count: number }).count),
    4,
  )

  console.log(JSON.stringify({
    atomicReservation: true,
    totalAndDomainIntersection: true,
    roleSharedQuota: true,
    userOverrideQuota: true,
    unlimitedAndDisabledSemantics: true,
    usageStatistics: true,
    sharedUsageSeparatesUserHistoryFromRoleWindow: true,
    expiredReservationRecovery: true,
    historySurvivesUserDeletion: true,
    bidirectionalDomainModes: true,
    perMailboxRollingQuota: true,
    perMailboxLifetimeQuotaSurvivesRecreation: true,
    mailboxQuotaIsolatedPerUserUnderRoleScope: true,
    exactMailboxOverridesDomainDefault: true,
    emperorQuotaReset: true,
  }))
  quota.setSendQuotaDatabaseForValidation()
} finally {
  sqlite?.close()
  process.chdir(previousCwd)
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
