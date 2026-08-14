import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import {
  analyzeMailQuotaRuleRelations,
  type MailQuotaRuleRelations,
} from "../../app/lib/mail-quota-rule-relations"
import type {
  MailDirection,
  MailQuotaAssignment,
  MailQuotaSubject,
  MailQuotaTarget,
} from "../../app/lib/access-policies"

function rule(direction: MailDirection, subject: MailQuotaSubject, target: MailQuotaTarget): MailQuotaAssignment {
  return {
    id: randomUUID(),
    direction,
    subject,
    target,
    rolling: { limit: 10, windowValue: 1, windowUnit: "day" },
    lifetimeLimit: target.type === "mailbox" ? 100 : -1,
    shareWithinRole: false,
    ignoreEmperor: false,
  }
}

const roleAll = rule("send", { type: "role", role: "knight" }, { type: "all" })
const roleDomain = rule("send", { type: "role", role: "knight" }, { type: "domain", domain: "example.test" })
const roleMailbox = rule("send", { type: "role", role: "knight" }, { type: "mailbox", address: "box@example.test" })
const globalDomain = rule("send", { type: "all" }, { type: "domain", domain: "example.test" })
const userMailbox = rule("send", { type: "user", userId: "user-a" }, { type: "mailbox", address: "box@example.test" })
const otherDirection = rule("receive", { type: "role", role: "knight" }, { type: "all" })

const exact = analyzeMailQuotaRuleRelations(roleDomain, [roleDomain])
assert.equal(exact.duplicateId, roleDomain.id)

const specific = analyzeMailQuotaRuleRelations(roleMailbox, [roleAll, roleDomain])
assert.deepEqual(specific, {
  duplicateId: null,
  overrides: 2,
  fallbacks: 0,
  stacks: 0,
  conditionalSubjectPriority: 0,
  unrelated: 0,
} satisfies MailQuotaRuleRelations)

const fallback = analyzeMailQuotaRuleRelations(roleAll, [roleDomain, roleMailbox])
assert.equal(fallback.fallbacks, 2)
assert.equal(fallback.overrides, 0)

const stacked = analyzeMailQuotaRuleRelations(globalDomain, [roleAll, roleDomain, roleMailbox])
assert.equal(stacked.stacks, 3)

const conditional = analyzeMailQuotaRuleRelations(userMailbox, [roleAll, roleDomain, roleMailbox])
assert.equal(conditional.conditionalSubjectPriority, 3)

const disjoint = analyzeMailQuotaRuleRelations(
  rule("send", { type: "role", role: "duke" }, { type: "domain", domain: "other.test" }),
  [roleAll, roleDomain, roleMailbox, globalDomain, userMailbox, otherDirection],
)
assert.equal(disjoint.unrelated, 5)
assert.equal(disjoint.stacks, 0)

const excluded = analyzeMailQuotaRuleRelations(roleDomain, [roleDomain], roleDomain.id)
assert.equal(excluded.duplicateId, null)

console.log(JSON.stringify({
  duplicateDetected: true,
  specificOverrideExplained: true,
  broadFallbackExplained: true,
  globalScopedStackExplained: true,
  userRoleConditionReported: true,
  directionAndTargetIsolation: true,
  editSelfExcluded: true,
}))
