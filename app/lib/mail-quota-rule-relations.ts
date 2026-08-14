import type { MailQuotaAssignment, MailQuotaSubject, MailQuotaTarget } from "./access-policies"

type QuotaRuleIdentity = Pick<MailQuotaAssignment, "direction" | "subject" | "target">

export interface MailQuotaRuleRelations {
  duplicateId: string | null
  overrides: number
  fallbacks: number
  stacks: number
  conditionalSubjectPriority: number
  unrelated: number
}

function subjectIdentity(subject: MailQuotaSubject) {
  return subject.type === "all"
    ? "all"
    : subject.type === "role" ? `role:${subject.role}` : `user:${subject.userId}`
}

function targetIdentity(target: MailQuotaTarget) {
  return target.type === "all"
    ? "all"
    : target.type === "domain" ? `domain:${target.domain}` : `mailbox:${target.address}`
}

function mailboxDomain(address: string) {
  return address.slice(address.lastIndexOf("@") + 1)
}

function targetsOverlap(left: MailQuotaTarget, right: MailQuotaTarget) {
  if (left.type === "all" || right.type === "all") return true
  if (left.type === "domain" && right.type === "domain") return left.domain === right.domain
  if (left.type === "mailbox" && right.type === "mailbox") return left.address === right.address
  const domain = left.type === "domain" ? left.domain : right.type === "domain" ? right.domain : ""
  const address = left.type === "mailbox" ? left.address : right.type === "mailbox" ? right.address : ""
  return Boolean(domain && address && mailboxDomain(address) === domain)
}

function targetSpecificity(target: MailQuotaTarget) {
  return target.type === "mailbox" ? 2 : target.type === "domain" ? 1 : 0
}

function sameSubject(left: MailQuotaSubject, right: MailQuotaSubject) {
  return subjectIdentity(left) === subjectIdentity(right)
}

function globalAndScoped(left: MailQuotaSubject, right: MailQuotaSubject) {
  return (left.type === "all") !== (right.type === "all")
}

function userAndRole(left: MailQuotaSubject, right: MailQuotaSubject) {
  return (left.type === "user" && right.type === "role")
    || (left.type === "role" && right.type === "user")
}

/**
 * Explains relationships using the same invariants as quota resolution:
 * one global rule and one scoped rule may stack; within a subject identity,
 * mailbox > domain > all; a matching user rule wins over a role rule.
 * It deliberately reports user/role overlap as conditional because role
 * membership is not encoded in a quota assignment.
 */
export function analyzeMailQuotaRuleRelations(
  draft: QuotaRuleIdentity,
  rules: readonly MailQuotaAssignment[],
  excludeId?: string,
): MailQuotaRuleRelations {
  const result: MailQuotaRuleRelations = {
    duplicateId: null,
    overrides: 0,
    fallbacks: 0,
    stacks: 0,
    conditionalSubjectPriority: 0,
    unrelated: 0,
  }
  const draftSubject = subjectIdentity(draft.subject)
  const draftTarget = targetIdentity(draft.target)

  for (const rule of rules) {
    if (rule.id === excludeId || rule.direction !== draft.direction) continue
    if (draftSubject === subjectIdentity(rule.subject) && draftTarget === targetIdentity(rule.target)) {
      result.duplicateId ??= rule.id
      continue
    }
    if (!targetsOverlap(draft.target, rule.target)) {
      result.unrelated += 1
      continue
    }
    if (sameSubject(draft.subject, rule.subject)) {
      if (targetSpecificity(draft.target) > targetSpecificity(rule.target)) result.overrides += 1
      else result.fallbacks += 1
      continue
    }
    if (globalAndScoped(draft.subject, rule.subject)) {
      result.stacks += 1
      continue
    }
    if (userAndRole(draft.subject, rule.subject)) {
      result.conditionalSubjectPriority += 1
      continue
    }
    result.unrelated += 1
  }
  return result
}
