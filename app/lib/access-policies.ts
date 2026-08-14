import { createHash } from "node:crypto"
import { z } from "zod"
import { CONFIG_KEYS, getConfigValues } from "./config-store"
import { getDatabaseDriver, getPostgresPool, getSqlite } from "./db"
import {
  normalizeMailboxAddress,
  normalizeMailboxDomain,
} from "./email-address"
import {
  PERMISSIONS,
  ROLES,
  type Permission,
  type Role,
} from "./permissions"

export const QUOTA_KEYS = [
  "maxActiveMailboxes",
  "maxMailboxLifetimeDays",
  "maxMessageBytes",
] as const

export const MAIL_QUOTA_UNITS = [
  "second",
  "minute",
  "hour",
  "day",
  "week",
  "month",
] as const

export const DOMAIN_ACCESS_MODES = [
  "allow",
  "receive",
  "send",
  "deny",
] as const

export type QuotaKey = typeof QUOTA_KEYS[number]
export type AccessQuotas = Record<QuotaKey, number>
export type PermissionMap = Record<Permission, boolean>
export type MailQuotaUnit = typeof MAIL_QUOTA_UNITS[number]
export type SendQuotaUnit = MailQuotaUnit
export type DomainAccessMode = typeof DOMAIN_ACCESS_MODES[number]
export type MailDirection = "send" | "receive"

export interface MailQuotaRule {
  /** -1 = unlimited, 0 = disabled, positive = maximum events in the rolling window. */
  limit: number
  windowValue: number
  windowUnit: MailQuotaUnit
}

export type SendQuotaRule = MailQuotaRule

export interface MailboxQuotaRule {
  rolling: MailQuotaRule
  /** -1 = unlimited, 0 = disabled, positive = lifetime maximum for this user/address identity. */
  lifetimeLimit: number
}

export interface MailQuotaPolicy {
  /** Aggregate total/domain counters are either per user or shared by the entire role. */
  scope: "user" | "role"
  total: MailQuotaRule
  domains: Record<string, MailQuotaRule>
  /** Default applied independently to every mailbox identity. */
  mailbox: MailboxQuotaRule
  /** Per-domain default for every mailbox in that domain. */
  domainMailboxes: Record<string, MailboxQuotaRule>
  /** Exact mailbox overrides take precedence over domain and global mailbox defaults. */
  mailboxes: Record<string, MailboxQuotaRule>
}

export type SendQuotaPolicy = MailQuotaPolicy

export interface MailQuotaOverride {
  total?: MailQuotaRule
  domains?: Record<string, MailQuotaRule>
  mailbox?: MailboxQuotaRule
  domainMailboxes?: Record<string, MailboxQuotaRule>
  mailboxes?: Record<string, MailboxQuotaRule>
}

export type SendQuotaOverride = MailQuotaOverride

export type MailQuotaSubject =
  | { type: "all" }
  | { type: "role"; role: Role }
  | { type: "user"; userId: string }

export type MailQuotaTarget =
  | { type: "all" }
  | { type: "domain"; domain: string }
  | { type: "mailbox"; address: string }

/** A quota assignment. Global rules are shared; role rules can optionally
 * share a pool, while all other counters are isolated per concrete user. */
export interface MailQuotaAssignment {
  id: string
  direction: MailDirection
  subject: MailQuotaSubject
  target: MailQuotaTarget
  rolling: MailQuotaRule
  /** Only exact-mailbox targets can have a non-negative lifetime limit. */
  lifetimeLimit: number
  /** Only role subjects may opt into one shared pool for the whole role. */
  shareWithinRole: boolean
  /** Only global subjects may exclude Emperor accounts from their pool. */
  ignoreEmperor: boolean
}

export interface DomainAccessPolicy {
  /** Default for configured domains without an explicit entry, including domains added later. */
  default: DomainAccessMode
  domains: Record<string, DomainAccessMode>
}

export interface DomainAccessOverride {
  default?: DomainAccessMode
  domains?: Record<string, DomainAccessMode>
}

export interface EffectiveAccessPolicy {
  permissions: PermissionMap
  quotas: AccessQuotas
  domainAccess: DomainAccessPolicy
  /** Compatibility projection: domains with at least one allowed direction. */
  allowedDomains: string[] | null
  /** Rules whose subject matches this user. Selection happens per address. */
  mailQuotaRules: MailQuotaAssignment[]
  quotaRole: Role
  roles: Role[]
}

const permissionShape = Object.fromEntries(
  Object.values(PERMISSIONS).map(permission => [permission, z.boolean()]),
) as Record<Permission, z.ZodBoolean>

type LegacyPermission = Exclude<
  Permission,
  typeof PERMISSIONS.PRIVATE_RECIPIENT_DELIVERY | typeof PERMISSIONS.MANAGE_MAILU
>
const legacyPermissionValues = Object.values(PERMISSIONS).filter(
  (permission): permission is LegacyPermission => (
    permission !== PERMISSIONS.PRIVATE_RECIPIENT_DELIVERY
    && permission !== PERMISSIONS.MANAGE_MAILU
  ),
)
const legacyPermissionShape = Object.fromEntries(
  legacyPermissionValues.map(permission => [permission, z.boolean()]),
) as Record<LegacyPermission, z.ZodBoolean>

function legacyPermissions(permissions: Partial<PermissionMap>) {
  return Object.fromEntries(legacyPermissionValues.map(permission => [
    permission,
    permissions[permission] ?? false,
  ])) as Record<LegacyPermission, boolean>
}

const permissionOverridesSchema = z.object(permissionShape).partial().strict()
const legacyPermissionOverridesSchema = z.object(legacyPermissionShape).partial().strict()

const quotaShape = {
  maxActiveMailboxes: z.number().int().min(0).max(100_000),
  maxMailboxLifetimeDays: z.number().int().min(0).max(36_500),
  maxMessageBytes: z.number().int().min(0).max(25 * 1024 * 1024),
} satisfies Record<QuotaKey, z.ZodNumber>

const version3QuotaShape = {
  ...quotaShape,
  dailyReceiveLimit: z.number().int().min(0).max(10_000_000),
}

const legacyQuotaShape = {
  ...version3QuotaShape,
  dailySendLimit: z.number().int().min(0).max(1_000_000),
}

const quotaOverridesSchema = z.object(quotaShape).partial().strict()
const version3QuotaOverridesSchema = z.object(version3QuotaShape).partial().strict()
const legacyQuotaOverridesSchema = z.object(legacyQuotaShape).partial().strict()

const explicitDomainListSchema = z.array(z.string().transform((value, ctx) => {
  const normalized = normalizeMailboxDomain(value)
  if (!normalized) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "INVALID_MAIL_DOMAIN" })
    return z.NEVER
  }
  return normalized
})).max(100).superRefine((domains, ctx) => {
  const seen = new Set<string>()
  domains.forEach((domain, index) => {
    if (seen.has(domain)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: "DUPLICATE_MAIL_DOMAIN" })
    }
    seen.add(domain)
  })
})
const allowedDomainsSchema = z.union([explicitDomainListSchema, z.null()])

export const mailQuotaRuleSchema = z.object({
  limit: z.number().int().min(-1).max(1_000_000_000),
  windowValue: z.number().int().min(1).max(100_000),
  windowUnit: z.enum(MAIL_QUOTA_UNITS),
}).strict()

export const sendQuotaRuleSchema = mailQuotaRuleSchema

export const mailboxQuotaRuleSchema = z.object({
  rolling: mailQuotaRuleSchema,
  lifetimeLimit: z.number().int().min(-1).max(1_000_000_000),
}).strict()

function normalizedDomainRecord<T extends z.ZodTypeAny>(value: T, maximum: number) {
  return z.record(z.string().min(1).max(253), value).superRefine((record, ctx) => {
    const entries = Object.keys(record)
    if (entries.length > maximum) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "TOO_MANY_DOMAIN_RULES" })
    }
    for (const domain of entries) {
      if (normalizeMailboxDomain(domain) !== domain) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [domain], message: "INVALID_MAIL_DOMAIN" })
      }
    }
  })
}

function normalizedMailboxRecord<T extends z.ZodTypeAny>(value: T, maximum: number) {
  return z.record(z.string().min(3).max(254), value).superRefine((record, ctx) => {
    const entries = Object.keys(record)
    if (entries.length > maximum) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "TOO_MANY_MAILBOX_RULES" })
    }
    for (const address of entries) {
      if (normalizeMailboxAddress(address) !== address) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [address], message: "INVALID_MAILBOX_ADDRESS" })
      }
    }
  })
}

const domainQuotaRulesSchema = normalizedDomainRecord(mailQuotaRuleSchema, 100)
const domainMailboxRulesSchema = normalizedDomainRecord(mailboxQuotaRuleSchema, 100)
const exactMailboxRulesSchema = normalizedMailboxRecord(mailboxQuotaRuleSchema, 500)
const domainAccessRulesSchema = normalizedDomainRecord(z.enum(DOMAIN_ACCESS_MODES), 100)

export const mailQuotaPolicySchema = z.object({
  scope: z.enum(["user", "role"]),
  total: mailQuotaRuleSchema,
  domains: domainQuotaRulesSchema,
  mailbox: mailboxQuotaRuleSchema,
  domainMailboxes: domainMailboxRulesSchema,
  mailboxes: exactMailboxRulesSchema,
}).strict()

export const sendQuotaPolicySchema = mailQuotaPolicySchema

export const mailQuotaOverrideSchema = z.object({
  total: mailQuotaRuleSchema.optional(),
  domains: domainQuotaRulesSchema.optional(),
  mailbox: mailboxQuotaRuleSchema.optional(),
  domainMailboxes: domainMailboxRulesSchema.optional(),
  mailboxes: exactMailboxRulesSchema.optional(),
}).strict()

export const sendQuotaOverrideSchema = mailQuotaOverrideSchema

const domainAccessPolicySchema = z.object({
  default: z.enum(DOMAIN_ACCESS_MODES),
  domains: domainAccessRulesSchema,
}).strict()

const domainAccessOverrideSchema = z.object({
  default: z.enum(DOMAIN_ACCESS_MODES).optional(),
  domains: domainAccessRulesSchema.optional(),
}).strict()

const version3MailQuotaPolicySchema = z.object({
  scope: z.enum(["user", "role"]),
  total: mailQuotaRuleSchema,
  domains: domainQuotaRulesSchema,
}).strict()

const version3MailQuotaOverrideSchema = z.object({
  total: mailQuotaRuleSchema.optional(),
  domains: domainQuotaRulesSchema.optional(),
}).strict()

const legacyCompleteRolePolicySchema = z.object({
  permissions: z.object(legacyPermissionShape).strict(),
  quotas: z.object(legacyQuotaShape).strict(),
}).strict()
const version2CompleteRolePolicySchema = legacyCompleteRolePolicySchema.extend({
  allowedDomains: allowedDomainsSchema,
}).strict()
const version3CompleteRolePolicySchema = z.object({
  permissions: z.object(legacyPermissionShape).strict(),
  quotas: z.object(version3QuotaShape).strict(),
  allowedDomains: allowedDomainsSchema,
  sendQuota: version3MailQuotaPolicySchema,
}).strict()

const completeRolePolicySchema = z.object({
  permissions: z.object(legacyPermissionShape).strict(),
  quotas: z.object(quotaShape).strict(),
  domainAccess: domainAccessPolicySchema,
  sendQuota: mailQuotaPolicySchema,
  receiveQuota: mailQuotaPolicySchema,
}).strict()

const legacyUserOverrideSchema = z.object({
  permissions: legacyPermissionOverridesSchema.default({}),
  quotas: legacyQuotaOverridesSchema.default({}),
}).strict()
const version2UserOverrideSchema = legacyUserOverrideSchema.extend({
  allowedDomains: allowedDomainsSchema.optional(),
}).strict()
const version3UserOverrideSchema = z.object({
  permissions: legacyPermissionOverridesSchema.default({}),
  quotas: version3QuotaOverridesSchema.default({}),
  allowedDomains: allowedDomainsSchema.optional(),
  sendQuota: version3MailQuotaOverrideSchema.optional(),
}).strict()
const userOverrideSchema = z.object({
  permissions: legacyPermissionOverridesSchema.default({}),
  quotas: quotaOverridesSchema.default({}),
  domainAccess: domainAccessOverrideSchema.optional(),
  sendQuota: mailQuotaOverrideSchema.optional(),
  receiveQuota: mailQuotaOverrideSchema.optional(),
}).strict()

const userIdSchema = z.string().min(1).max(128).refine(value => !/[\x00-\x1f\x7f]/.test(value))
const nonEmperorRoles = [ROLES.DUKE, ROLES.KNIGHT, ROLES.CIVILIAN] as const
const allRoles = [ROLES.EMPEROR, ...nonEmperorRoles] as const

const quotaSubjectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("all") }).strict(),
  z.object({ type: z.literal("role"), role: z.enum(allRoles) }).strict(),
  z.object({ type: z.literal("user"), userId: userIdSchema }).strict(),
])

const quotaTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("all") }).strict(),
  z.object({
    type: z.literal("domain"),
    domain: z.string().transform((value, ctx) => {
      const normalized = normalizeMailboxDomain(value)
      if (!normalized) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "INVALID_MAIL_DOMAIN" })
        return z.NEVER
      }
      return normalized
    }),
  }).strict(),
  z.object({
    type: z.literal("mailbox"),
    address: z.string().transform((value, ctx) => {
      const normalized = normalizeMailboxAddress(value)
      if (!normalized) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "INVALID_MAILBOX_ADDRESS" })
        return z.NEVER
      }
      return normalized
    }),
  }).strict(),
])

export const mailQuotaAssignmentSchema = z.object({
  id: z.string().uuid(),
  direction: z.enum(["send", "receive"]),
  subject: quotaSubjectSchema,
  target: quotaTargetSchema,
  rolling: mailQuotaRuleSchema,
  lifetimeLimit: z.number().int().min(-1).max(1_000_000_000),
  shareWithinRole: z.boolean().default(false),
  ignoreEmperor: z.boolean().default(false),
}).strict().superRefine((assignment, ctx) => {
  if (assignment.target.type !== "mailbox" && assignment.lifetimeLimit !== -1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lifetimeLimit"], message: "LIFETIME_LIMIT_REQUIRES_MAILBOX" })
  }
  if (assignment.shareWithinRole && assignment.subject.type !== "role") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["shareWithinRole"], message: "SHARED_POOL_REQUIRES_ROLE" })
  }
  if (assignment.ignoreEmperor && assignment.subject.type !== "all") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ignoreEmperor"], message: "IGNORE_EMPEROR_REQUIRES_GLOBAL" })
  }
})

function assignmentKey(assignment: Pick<MailQuotaAssignment, "direction" | "subject" | "target">) {
  const subject = assignment.subject.type === "all"
    ? "all"
    : assignment.subject.type === "role"
      ? `role:${assignment.subject.role}`
      : `user:${assignment.subject.userId}`
  const target = assignment.target.type === "all"
    ? "all"
    : assignment.target.type === "domain"
      ? `domain:${assignment.target.domain}`
      : `mailbox:${assignment.target.address}`
  return `${assignment.direction}|${subject}|${target}`
}

const mailQuotaAssignmentsSchema = z.array(mailQuotaAssignmentSchema).max(2_000).superRefine((assignments, ctx) => {
  const keys = new Set<string>()
  assignments.forEach((assignment, index) => {
    const key = assignmentKey(assignment)
    if (keys.has(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: "DUPLICATE_MAIL_QUOTA_ASSIGNMENT" })
    }
    keys.add(key)
  })
})

const legacyAccessPoliciesSchema = z.object({
  version: z.literal(1),
  roles: z.object({
    [ROLES.DUKE]: legacyCompleteRolePolicySchema,
    [ROLES.KNIGHT]: legacyCompleteRolePolicySchema,
    [ROLES.CIVILIAN]: legacyCompleteRolePolicySchema,
  }).strict(),
  users: z.record(userIdSchema, legacyUserOverrideSchema),
}).strict()

const version2AccessPoliciesSchema = z.object({
  version: z.literal(2),
  roles: z.object({
    [ROLES.DUKE]: version2CompleteRolePolicySchema,
    [ROLES.KNIGHT]: version2CompleteRolePolicySchema,
    [ROLES.CIVILIAN]: version2CompleteRolePolicySchema,
  }).strict(),
  users: z.record(userIdSchema, version2UserOverrideSchema),
}).strict()

const version3AccessPoliciesSchema = z.object({
  version: z.literal(3),
  roles: z.object({
    [ROLES.EMPEROR]: version3CompleteRolePolicySchema,
    [ROLES.DUKE]: version3CompleteRolePolicySchema,
    [ROLES.KNIGHT]: version3CompleteRolePolicySchema,
    [ROLES.CIVILIAN]: version3CompleteRolePolicySchema,
  }).strict(),
  users: z.record(userIdSchema, version3UserOverrideSchema),
}).strict()

const version4AccessPoliciesSchema = z.object({
  version: z.literal(4),
  roles: z.object({
    [ROLES.EMPEROR]: completeRolePolicySchema,
    [ROLES.DUKE]: completeRolePolicySchema,
    [ROLES.KNIGHT]: completeRolePolicySchema,
    [ROLES.CIVILIAN]: completeRolePolicySchema,
  }).strict(),
  users: z.record(userIdSchema, userOverrideSchema),
}).strict()

const rolePolicySchema = z.object({
  permissions: z.object(permissionShape).strict(),
  quotas: z.object(quotaShape).strict(),
  domainAccess: domainAccessPolicySchema,
}).strict()

const currentUserOverrideSchema = z.object({
  permissions: permissionOverridesSchema.default({}),
  quotas: quotaOverridesSchema.default({}),
  domainAccess: domainAccessOverrideSchema.optional(),
}).strict()

const version5AccessPoliciesSchema = z.object({
  version: z.literal(5),
  roles: z.object({
    [ROLES.EMPEROR]: z.object({
      permissions: z.object(legacyPermissionShape).strict(),
      quotas: z.object(quotaShape).strict(),
      domainAccess: domainAccessPolicySchema,
    }).strict(),
    [ROLES.DUKE]: z.object({
      permissions: z.object(legacyPermissionShape).strict(),
      quotas: z.object(quotaShape).strict(),
      domainAccess: domainAccessPolicySchema,
    }).strict(),
    [ROLES.KNIGHT]: z.object({
      permissions: z.object(legacyPermissionShape).strict(),
      quotas: z.object(quotaShape).strict(),
      domainAccess: domainAccessPolicySchema,
    }).strict(),
    [ROLES.CIVILIAN]: z.object({
      permissions: z.object(legacyPermissionShape).strict(),
      quotas: z.object(quotaShape).strict(),
      domainAccess: domainAccessPolicySchema,
    }).strict(),
  }).strict(),
  users: z.record(userIdSchema, z.object({
    permissions: legacyPermissionOverridesSchema.default({}),
    quotas: quotaOverridesSchema.default({}),
    domainAccess: domainAccessOverrideSchema.optional(),
  }).strict()),
  mailQuotaRules: mailQuotaAssignmentsSchema,
}).strict()

const version6AccessPoliciesSchema = z.object({
  version: z.literal(6),
  roles: z.object({
    [ROLES.EMPEROR]: z.object({
      permissions: z.object(legacyPermissionShape).extend({
        [PERMISSIONS.PRIVATE_RECIPIENT_DELIVERY]: z.boolean(),
      }).strict(),
      quotas: z.object(quotaShape).strict(),
      domainAccess: domainAccessPolicySchema,
    }).strict(),
    [ROLES.DUKE]: z.object({
      permissions: z.object(legacyPermissionShape).extend({
        [PERMISSIONS.PRIVATE_RECIPIENT_DELIVERY]: z.boolean(),
      }).strict(),
      quotas: z.object(quotaShape).strict(),
      domainAccess: domainAccessPolicySchema,
    }).strict(),
    [ROLES.KNIGHT]: z.object({
      permissions: z.object(legacyPermissionShape).extend({
        [PERMISSIONS.PRIVATE_RECIPIENT_DELIVERY]: z.boolean(),
      }).strict(),
      quotas: z.object(quotaShape).strict(),
      domainAccess: domainAccessPolicySchema,
    }).strict(),
    [ROLES.CIVILIAN]: z.object({
      permissions: z.object(legacyPermissionShape).extend({
        [PERMISSIONS.PRIVATE_RECIPIENT_DELIVERY]: z.boolean(),
      }).strict(),
      quotas: z.object(quotaShape).strict(),
      domainAccess: domainAccessPolicySchema,
    }).strict(),
  }).strict(),
  users: z.record(userIdSchema, z.object({
    permissions: z.object(legacyPermissionShape).extend({
      [PERMISSIONS.PRIVATE_RECIPIENT_DELIVERY]: z.boolean().optional(),
    }).partial().strict().default({}),
    quotas: quotaOverridesSchema.default({}),
    domainAccess: domainAccessOverrideSchema.optional(),
  }).strict()),
  mailQuotaRules: mailQuotaAssignmentsSchema,
}).strict()

const accessPoliciesSchema = z.object({
  version: z.literal(7),
  roles: z.object({
    [ROLES.EMPEROR]: rolePolicySchema,
    [ROLES.DUKE]: rolePolicySchema,
    [ROLES.KNIGHT]: rolePolicySchema,
    [ROLES.CIVILIAN]: rolePolicySchema,
  }).strict(),
  users: z.record(userIdSchema, currentUserOverrideSchema),
  mailQuotaRules: mailQuotaAssignmentsSchema,
}).strict().superRefine((policies, ctx) => {
  const emperor = policies.roles[ROLES.EMPEROR]
  if (!Object.values(emperor.permissions).every(Boolean)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["roles", ROLES.EMPEROR, "permissions"], message: "EMPEROR_PERMISSIONS_IMMUTABLE" })
  }
  if (!Object.values(emperor.quotas).every(value => value === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["roles", ROLES.EMPEROR, "quotas"], message: "EMPEROR_GENERAL_QUOTAS_IMMUTABLE" })
  }
  if (emperor.domainAccess.default !== "allow" || Object.keys(emperor.domainAccess.domains).length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["roles", ROLES.EMPEROR, "domainAccess"], message: "EMPEROR_DOMAINS_IMMUTABLE" })
  }
})

export type AccessPolicies = z.infer<typeof accessPoliciesSchema>
export type UserAccessOverride = z.infer<typeof currentUserOverrideSchema>

const allPermissions = () => Object.fromEntries(
  Object.values(PERMISSIONS).map(permission => [permission, true]),
) as PermissionMap

const noPermissions = () => Object.fromEntries(
  Object.values(PERMISSIONS).map(permission => [permission, false]),
) as PermissionMap

const enabledPermissions = (...permissions: Permission[]) => ({
  ...noPermissions(),
  ...Object.fromEntries(permissions.map(permission => [permission, true])),
}) as PermissionMap

export function unlimitedMailQuotaRule(): MailQuotaRule {
  return { limit: -1, windowValue: 1, windowUnit: "day" }
}

export const unlimitedSendQuotaRule = unlimitedMailQuotaRule

export function disabledMailQuotaRule(): MailQuotaRule {
  return { limit: 0, windowValue: 1, windowUnit: "day" }
}

export const disabledSendQuotaRule = disabledMailQuotaRule

export function unlimitedMailboxQuotaRule(): MailboxQuotaRule {
  return { rolling: unlimitedMailQuotaRule(), lifetimeLimit: -1 }
}

function legacyMailQuota(total: MailQuotaRule): MailQuotaPolicy {
  return {
    scope: "user",
    total,
    domains: {},
    mailbox: unlimitedMailboxQuotaRule(),
    domainMailboxes: {},
    mailboxes: {},
  }
}

function quotaAssignmentId(input: Pick<MailQuotaAssignment, "direction" | "subject" | "target">) {
  const hex = createHash("sha256").update(`moemail:mail-quota:${assignmentKey(input)}`).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Version-4 quota events predate explicit rule IDs. Only assignments whose
 * complete identity matches the deterministic migration ID may read that
 * legacy NULL history; an arbitrary UUID supplied by an administrator may not. */
export function isMigratedMailQuotaAssignment(assignment: MailQuotaAssignment) {
  return assignment.subject.type !== "all" && assignment.id === quotaAssignmentId(assignment)
}

function quotaAssignment(
  direction: MailDirection,
  subject: MailQuotaSubject,
  target: MailQuotaTarget,
  rolling: MailQuotaRule,
  lifetimeLimit = -1,
  options: { shareWithinRole?: boolean; ignoreEmperor?: boolean } = {},
): MailQuotaAssignment {
  const identity = { direction, subject, target }
  return {
    id: quotaAssignmentId(identity),
    ...identity,
    rolling,
    lifetimeLimit,
    shareWithinRole: options.shareWithinRole ?? false,
    ignoreEmperor: options.ignoreEmperor ?? false,
  }
}

function legacyDailySendRule(value: number): MailQuotaRule {
  return value === 0
    ? unlimitedMailQuotaRule()
    : { limit: Math.max(0, value), windowValue: 1, windowUnit: "day" }
}

function legacyDailyReceiveRule(value: number): MailQuotaRule {
  return value === 0
    ? unlimitedMailQuotaRule()
    : { limit: value, windowValue: 1, windowUnit: "day" }
}

function allDomainAccess(): DomainAccessPolicy {
  return { default: "allow", domains: {} }
}

export const EMPEROR_ACCESS_POLICY: EffectiveAccessPolicy = {
  permissions: Object.freeze(allPermissions()),
  quotas: Object.freeze({
    maxActiveMailboxes: 0,
    maxMailboxLifetimeDays: 0,
    maxMessageBytes: 0,
  }),
  domainAccess: Object.freeze(allDomainAccess()),
  allowedDomains: null,
  mailQuotaRules: [],
  quotaRole: ROLES.EMPEROR,
  roles: [ROLES.EMPEROR],
}
Object.freeze(EMPEROR_ACCESS_POLICY.permissions)
Object.freeze(EMPEROR_ACCESS_POLICY.quotas)
Object.freeze(EMPEROR_ACCESS_POLICY.domainAccess)
Object.freeze(EMPEROR_ACCESS_POLICY.mailQuotaRules)
Object.freeze(EMPEROR_ACCESS_POLICY.roles)
Object.freeze(EMPEROR_ACCESS_POLICY)

function roleDefaults(maxActiveMailboxes: number, sendLimits: { duke: number; knight: number }) {
  const commonMailPermissions = [
    PERMISSIONS.VIEW_EMAIL,
    PERMISSIONS.CREATE_EMAIL,
    PERMISSIONS.DELETE_EMAIL,
    PERMISSIONS.RECEIVE_EMAIL,
    PERMISSIONS.SHARE_EMAIL,
  ] as const
  const generalQuotas = (overrides: Partial<AccessQuotas> = {}): AccessQuotas => ({
    maxActiveMailboxes,
    maxMailboxLifetimeDays: 0,
    maxMessageBytes: 25 * 1024 * 1024,
    ...overrides,
  })
  const rolePolicy = (permissions: PermissionMap, quotas: AccessQuotas) => ({
    permissions,
    quotas,
    domainAccess: allDomainAccess(),
  })

  return {
    [ROLES.EMPEROR]: rolePolicy(
      allPermissions(),
      generalQuotas({ maxActiveMailboxes: 0, maxMessageBytes: 0 }),
    ),
    [ROLES.DUKE]: rolePolicy(
      enabledPermissions(
        ...commonMailPermissions,
        ...(sendLimits.duke >= 0
          ? [PERMISSIONS.SEND_EMAIL, PERMISSIONS.PRIVATE_RECIPIENT_DELIVERY]
          : []),
        PERMISSIONS.MANAGE_WEBHOOK,
        PERMISSIONS.MANAGE_API_KEY,
      ),
      generalQuotas(),
    ),
    [ROLES.KNIGHT]: rolePolicy(
      enabledPermissions(
        ...commonMailPermissions,
        ...(sendLimits.knight >= 0
          ? [PERMISSIONS.SEND_EMAIL, PERMISSIONS.PRIVATE_RECIPIENT_DELIVERY]
          : []),
        PERMISSIONS.MANAGE_WEBHOOK,
      ),
      generalQuotas(),
    ),
    [ROLES.CIVILIAN]: rolePolicy(
      noPermissions(),
      generalQuotas(),
    ),
  } satisfies AccessPolicies["roles"]
}

export function createDefaultAccessPolicies(): AccessPolicies {
  const roles = roleDefaults(30, { duke: 5, knight: 2 })
  return {
    version: 7,
    roles,
    users: {},
    mailQuotaRules: [
      quotaAssignment("send", { type: "role", role: ROLES.DUKE }, { type: "all" }, legacyDailySendRule(5)),
      quotaAssignment("send", { type: "role", role: ROLES.KNIGHT }, { type: "all" }, legacyDailySendRule(2)),
      quotaAssignment("send", { type: "role", role: ROLES.CIVILIAN }, { type: "all" }, disabledMailQuotaRule()),
    ],
  }
}

function migrateAllowedDomains(value: string[] | null | undefined): DomainAccessPolicy {
  if (value === null || value === undefined) return allDomainAccess()
  return {
    default: "deny",
    domains: Object.fromEntries(value.map(domain => [domain, "allow" as const])),
  }
}

function expandVersion3Quota(policy: z.infer<typeof version3MailQuotaPolicySchema>): MailQuotaPolicy {
  return {
    ...policy,
    mailbox: unlimitedMailboxQuotaRule(),
    domainMailboxes: {},
    mailboxes: {},
  }
}

function migrateLegacyRole(
  role: z.infer<typeof legacyCompleteRolePolicySchema> & { allowedDomains?: string[] | null },
) {
  const { dailySendLimit, dailyReceiveLimit, ...quotas } = role.quotas
  return {
    permissions: role.permissions,
    quotas,
    domainAccess: migrateAllowedDomains(role.allowedDomains),
    sendQuota: legacyMailQuota(legacyDailySendRule(dailySendLimit)),
    receiveQuota: legacyMailQuota(legacyDailyReceiveRule(dailyReceiveLimit)),
  }
}

function migrateLegacyUser(user: z.infer<typeof version2UserOverrideSchema>): UserAccessOverride {
  const { dailySendLimit, dailyReceiveLimit, ...quotas } = user.quotas
  return {
    permissions: user.permissions,
    quotas,
    ...(user.allowedDomains === undefined
      ? {}
      : { domainAccess: migrateAllowedDomains(user.allowedDomains) }),
    ...(dailySendLimit === undefined
      ? {}
      : { sendQuota: { total: legacyDailySendRule(dailySendLimit) } }),
    ...(dailyReceiveLimit === undefined
      ? {}
      : { receiveQuota: { total: legacyDailyReceiveRule(dailyReceiveLimit) } }),
  }
}

function migrateVersion3Role(role: z.infer<typeof version3CompleteRolePolicySchema>) {
  const { dailyReceiveLimit, ...quotas } = role.quotas
  return {
    permissions: role.permissions,
    quotas,
    domainAccess: migrateAllowedDomains(role.allowedDomains),
    sendQuota: expandVersion3Quota(role.sendQuota),
    receiveQuota: legacyMailQuota(legacyDailyReceiveRule(dailyReceiveLimit)),
  }
}

function migrateVersion3User(user: z.infer<typeof version3UserOverrideSchema>): UserAccessOverride {
  const { dailyReceiveLimit, ...quotas } = user.quotas
  return {
    permissions: user.permissions,
    quotas,
    ...(user.allowedDomains === undefined
      ? {}
      : { domainAccess: migrateAllowedDomains(user.allowedDomains) }),
    ...(user.sendQuota === undefined
      ? {}
      : { sendQuota: user.sendQuota }),
    ...(dailyReceiveLimit === undefined
      ? {}
      : { receiveQuota: { total: legacyDailyReceiveRule(dailyReceiveLimit) } }),
  }
}

function stripLegacyRole(role: z.infer<typeof completeRolePolicySchema>) {
  return {
    permissions: {
      ...role.permissions,
      [PERMISSIONS.PRIVATE_RECIPIENT_DELIVERY]: role.permissions[PERMISSIONS.SEND_EMAIL],
    },
    quotas: role.quotas,
    domainAccess: role.domainAccess,
  }
}

function stripLegacyUser(user: z.infer<typeof userOverrideSchema>): UserAccessOverride {
  return {
    permissions: {
      ...user.permissions,
      ...(user.permissions[PERMISSIONS.SEND_EMAIL] === true
        ? { [PERMISSIONS.PRIVATE_RECIPIENT_DELIVERY]: true }
        : {}),
    },
    quotas: user.quotas,
    ...(user.domainAccess ? { domainAccess: user.domainAccess } : {}),
  }
}

function legacyPolicyRules(
  subject: MailQuotaSubject,
  direction: MailDirection,
  policy: MailQuotaPolicy | MailQuotaOverride | undefined,
) {
  if (!policy) return []
  const rules: MailQuotaAssignment[] = []
  const shareWithinRole = subject.type === "role" && "scope" in policy && policy.scope === "role"
  const options = { shareWithinRole }
  const unlimitedRolling = (rule: MailQuotaRule) => rule.limit === -1
  const unlimitedMailbox = (rule: MailboxQuotaRule) => unlimitedRolling(rule.rolling) && rule.lifetimeLimit === -1
  // Version 4 stacked aggregate and wildcard-per-mailbox counters. Version 5
  // deliberately selects only one rule per subject layer. Prefer an explicit
  // aggregate; when it was unlimited, promote a customized wildcard mailbox
  // default to the nearest conservative aggregate instead of silently losing
  // the old restriction.
  if (policy.total && (!unlimitedRolling(policy.total) || !policy.mailbox || unlimitedMailbox(policy.mailbox))) {
    rules.push(quotaAssignment(direction, subject, { type: "all" }, policy.total, -1, options))
  } else if (policy.mailbox && !unlimitedMailbox(policy.mailbox)) {
    rules.push(quotaAssignment(direction, subject, { type: "all" }, policy.mailbox.rolling, -1, options))
  }
  for (const [domain, rolling] of Object.entries(policy.domains ?? {})) {
    rules.push(quotaAssignment(direction, subject, { type: "domain", domain }, rolling, -1, options))
  }
  for (const [domain, mailbox] of Object.entries(policy.domainMailboxes ?? {})) {
    // Version 4 could stack a domain aggregate and a per-mailbox rule. The
    // latter is the more specific intent in the replacement model.
    if (!(domain in (policy.domains ?? {}))) {
      rules.push(quotaAssignment(direction, subject, { type: "domain", domain }, mailbox.rolling, -1, options))
    }
  }
  for (const [address, mailbox] of Object.entries(policy.mailboxes ?? {})) {
    rules.push(quotaAssignment(direction, subject, { type: "mailbox", address }, mailbox.rolling, mailbox.lifetimeLimit, options))
  }
  return rules
}

function migrateVersion4(input: z.infer<typeof version4AccessPoliciesSchema>): AccessPolicies {
  const roleRules = allRoles.flatMap(role => ([
    ...legacyPolicyRules({ type: "role", role }, "send", input.roles[role].sendQuota),
    ...legacyPolicyRules({ type: "role", role }, "receive", input.roles[role].receiveQuota),
  ]))
  const userRules = Object.entries(input.users).flatMap(([userId, user]) => ([
    ...legacyPolicyRules({ type: "user", userId }, "send", user.sendQuota),
    ...legacyPolicyRules({ type: "user", userId }, "receive", user.receiveQuota),
  ]))
  const deduplicated = new Map<string, MailQuotaAssignment>()
  for (const assignment of [...roleRules, ...userRules]) deduplicated.set(assignmentKey(assignment), assignment)
  return accessPoliciesSchema.parse({
    version: 7,
    roles: Object.fromEntries(allRoles.map(role => [role, {
      ...stripLegacyRole(input.roles[role]),
      permissions: {
        ...stripLegacyRole(input.roles[role]).permissions,
        [PERMISSIONS.MANAGE_MAILU]: role === ROLES.EMPEROR,
      },
    }])),
    users: Object.fromEntries(Object.entries(input.users).map(([id, user]) => [id, stripLegacyUser(user)])),
    mailQuotaRules: [...deduplicated.values()],
  })
}

function parseStoredAccessPolicies(input: unknown): AccessPolicies {
  const version = typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as { version?: unknown }).version
    : undefined
  if (version === 1) {
    const legacy = legacyAccessPoliciesSchema.parse(input)
    const currentEmperor = createDefaultAccessPolicies().roles[ROLES.EMPEROR]
    const emperor = { ...currentEmperor, permissions: legacyPermissions(currentEmperor.permissions) }
    return migrateVersion4(version4AccessPoliciesSchema.parse({
      version: 4,
      roles: {
        [ROLES.EMPEROR]: {
          ...emperor,
          sendQuota: legacyMailQuota(unlimitedMailQuotaRule()),
          receiveQuota: legacyMailQuota(unlimitedMailQuotaRule()),
        },
        ...Object.fromEntries(nonEmperorRoles.map(role => [role, migrateLegacyRole(legacy.roles[role])])),
      },
      users: Object.fromEntries(Object.entries(legacy.users).map(([id, user]) => [id, migrateLegacyUser(user)])),
    }))
  }
  if (version === 2) {
    const legacy = version2AccessPoliciesSchema.parse(input)
    const currentEmperor = createDefaultAccessPolicies().roles[ROLES.EMPEROR]
    const emperor = { ...currentEmperor, permissions: legacyPermissions(currentEmperor.permissions) }
    return migrateVersion4(version4AccessPoliciesSchema.parse({
      version: 4,
      roles: {
        [ROLES.EMPEROR]: {
          ...emperor,
          sendQuota: legacyMailQuota(unlimitedMailQuotaRule()),
          receiveQuota: legacyMailQuota(unlimitedMailQuotaRule()),
        },
        ...Object.fromEntries(nonEmperorRoles.map(role => [role, migrateLegacyRole(legacy.roles[role])])),
      },
      users: Object.fromEntries(Object.entries(legacy.users).map(([id, user]) => [id, migrateLegacyUser(user)])),
    }))
  }
  if (version === 3) {
    const legacy = version3AccessPoliciesSchema.parse(input)
    return migrateVersion4(version4AccessPoliciesSchema.parse({
      version: 4,
      roles: Object.fromEntries(allRoles.map(role => [role, migrateVersion3Role(legacy.roles[role])])),
      users: Object.fromEntries(Object.entries(legacy.users).map(([id, user]) => [id, migrateVersion3User(user)])),
    }))
  }
  if (version === 4) return migrateVersion4(version4AccessPoliciesSchema.parse(input))
  if (version === 5) {
    const legacy = version5AccessPoliciesSchema.parse(input)
    return accessPoliciesSchema.parse({
      ...legacy,
      version: 7,
      roles: Object.fromEntries(allRoles.map(role => [role, {
        ...legacy.roles[role],
        permissions: {
          ...legacy.roles[role].permissions,
          [PERMISSIONS.PRIVATE_RECIPIENT_DELIVERY]: legacy.roles[role].permissions[PERMISSIONS.SEND_EMAIL],
          [PERMISSIONS.MANAGE_MAILU]: role === ROLES.EMPEROR,
        },
      }])),
      users: Object.fromEntries(Object.entries(legacy.users).map(([id, user]) => [id, {
        ...user,
        permissions: {
          ...user.permissions,
          ...(user.permissions[PERMISSIONS.SEND_EMAIL] === true
            ? { [PERMISSIONS.PRIVATE_RECIPIENT_DELIVERY]: true }
            : {}),
        },
      }])),
    })
  }
  if (version === 6) {
    const legacy = version6AccessPoliciesSchema.parse(input)
    return accessPoliciesSchema.parse({
      ...legacy,
      version: 7,
      roles: Object.fromEntries(allRoles.map(role => [role, {
        ...legacy.roles[role],
        permissions: {
          ...legacy.roles[role].permissions,
          [PERMISSIONS.MANAGE_MAILU]: role === ROLES.EMPEROR,
        },
      }])),
    })
  }
  return accessPoliciesSchema.parse(input)
}

/** Removes a deleted user's override while preserving/migrating the complete
 * policy document. The caller owns the surrounding database transaction. */
export function removeUserAccessOverrideFromDocument(
  stored: string | null | undefined,
  userId: string,
) {
  if (!stored) return null
  let input: unknown
  try {
    input = JSON.parse(stored)
  } catch {
    throw new Error("ACCESS_POLICIES_CORRUPTED")
  }
  const policies = parseStoredAccessPolicies(input)
  const hasRule = policies.mailQuotaRules.some(rule => rule.subject.type === "user" && rule.subject.userId === userId)
  if (!(userId in policies.users) && !hasRule) return stored
  const policyUsers = { ...policies.users }
  delete policyUsers[userId]
  return JSON.stringify(accessPoliciesSchema.parse({
    ...policies,
    users: policyUsers,
    mailQuotaRules: policies.mailQuotaRules.filter(rule => (
      rule.subject.type !== "user" || rule.subject.userId !== userId
    )),
  }))
}

function safePositiveInteger(value: string | null, fallback: number) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

async function legacyDefaults(): Promise<AccessPolicies> {
  const values = await getConfigValues([
    CONFIG_KEYS.ACCESS_POLICIES,
    CONFIG_KEYS.MAX_EMAILS,
    CONFIG_KEYS.EMAIL_ROLE_LIMITS,
  ])
  if (values.ACCESS_POLICIES) {
    let input: unknown
    try {
      input = JSON.parse(values.ACCESS_POLICIES)
    } catch {
      throw new Error("ACCESS_POLICIES_CORRUPTED")
    }
    return parseStoredAccessPolicies(input)
  }

  let roleLimits: Record<string, unknown> = {}
  try {
    roleLimits = values.EMAIL_ROLE_LIMITS ? JSON.parse(values.EMAIL_ROLE_LIMITS) : {}
  } catch {
    roleLimits = {}
  }
  const numberLimit = (role: "duke" | "knight", fallback: number) => {
    const value = roleLimits[role]
    return typeof value === "number" && Number.isSafeInteger(value) ? value : fallback
  }

  const sendLimits = {
    duke: numberLimit("duke", 5),
    knight: numberLimit("knight", 2),
  }
  return {
    version: 7,
    roles: roleDefaults(safePositiveInteger(values.MAX_EMAILS, 30), sendLimits),
    users: {},
    mailQuotaRules: [
      quotaAssignment("send", { type: "role", role: ROLES.DUKE }, { type: "all" }, legacyDailySendRule(Math.max(0, sendLimits.duke))),
      quotaAssignment("send", { type: "role", role: ROLES.KNIGHT }, { type: "all" }, legacyDailySendRule(Math.max(0, sendLimits.knight))),
      quotaAssignment("send", { type: "role", role: ROLES.CIVILIAN }, { type: "all" }, disabledMailQuotaRule()),
    ],
  }
}

export async function getAccessPolicies(): Promise<AccessPolicies> {
  // Migration is deliberately read-only here. Persisting from a GET could
  // overwrite a concurrent administrator update made after this read. The
  // next mutation upgrades and saves under updateAccessPolicies' DB lock.
  return legacyDefaults()
}

/**
 * Atomically reads, changes, validates, and persists the policy document.
 * Role edits and per-user edits therefore cannot overwrite each other when
 * two administrators save at the same time or separate app processes serve
 * the requests.
 */
export async function updateAccessPolicies(
  mutate: (current: AccessPolicies) => unknown,
): Promise<AccessPolicies> {
  const fallback = await legacyDefaults()
  const parseCurrent = (stored: string | null | undefined) => {
    if (!stored) return structuredClone(fallback)
    let value: unknown
    try {
      value = JSON.parse(stored)
    } catch {
      throw new Error("ACCESS_POLICIES_CORRUPTED")
    }
    return parseStoredAccessPolicies(value)
  }

  if (getDatabaseDriver() === "sqlite") {
    return getSqlite().transaction(() => {
      const stored = getSqlite().prepare(`
        SELECT value FROM site_config WHERE key = ? LIMIT 1
      `).get(CONFIG_KEYS.ACCESS_POLICIES) as { value?: string } | undefined
      const next = accessPoliciesSchema.parse(mutate(parseCurrent(stored?.value)))
      getSqlite().prepare(`
        INSERT INTO site_config (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(CONFIG_KEYS.ACCESS_POLICIES, JSON.stringify(next), Date.now())
      return next
    }).immediate()
  }

  const client = await getPostgresPool().connect()
  try {
    await client.query("BEGIN")
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      ["moemail:access-policies"],
    )
    const stored = await client.query<{ value: string }>(
      "SELECT value FROM site_config WHERE key = $1 FOR UPDATE",
      [CONFIG_KEYS.ACCESS_POLICIES],
    )
    const next = accessPoliciesSchema.parse(mutate(parseCurrent(stored.rows[0]?.value)))
    await client.query(`
      INSERT INTO site_config (key, value, updated_at) VALUES ($1, $2, NOW())
      ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
    `, [CONFIG_KEYS.ACCESS_POLICIES, JSON.stringify(next)])
    await client.query("COMMIT")
    return next
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export type UserAccessOverrideMutationResult =
  | "updated"
  | "not_found"
  | "emperor_immutable"

/**
 * Mutates one user's override only after re-checking the target user and their
 * Emperor role inside the same database transaction. The lock order matches
 * role assignment and user deletion, so a concurrent promotion/deletion
 * cannot leave a stale override or weaken an Emperor account.
 */
export async function mutateUserAccessOverride(
  userId: string,
  override: UserAccessOverride | null,
): Promise<UserAccessOverrideMutationResult> {
  const fallback = await legacyDefaults()
  const parseCurrent = (stored: string | null | undefined) => {
    if (!stored) return structuredClone(fallback)
    let value: unknown
    try {
      value = JSON.parse(stored)
    } catch {
      throw new Error("ACCESS_POLICIES_CORRUPTED")
    }
    return parseStoredAccessPolicies(value)
  }
  const mutate = (current: AccessPolicies) => {
    const policyUsers = { ...current.users }
    if (override === null) delete policyUsers[userId]
    else policyUsers[userId] = override
    return accessPoliciesSchema.parse({ ...current, users: policyUsers })
  }

  if (getDatabaseDriver() === "sqlite") {
    return getSqlite().transaction((): UserAccessOverrideMutationResult => {
      const target = getSqlite().prepare(
        `SELECT id FROM user WHERE id = ? LIMIT 1`,
      ).get(userId)
      if (!target) return "not_found"

      const emperor = getSqlite().prepare(`
        SELECT 1
        FROM user_role
        INNER JOIN role ON role.id = user_role.role_id
        WHERE user_role.user_id = ? AND role.name = 'emperor'
        LIMIT 1
      `).get(userId)
      if (override !== null && emperor && !isEmperorSafeOverride(override)) {
        return "emperor_immutable"
      }

      const stored = getSqlite().prepare(`
        SELECT value FROM site_config WHERE key = ? LIMIT 1
      `).get(CONFIG_KEYS.ACCESS_POLICIES) as { value?: string } | undefined
      const next = mutate(parseCurrent(stored?.value))
      getSqlite().prepare(`
        INSERT INTO site_config (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(CONFIG_KEYS.ACCESS_POLICIES, JSON.stringify(next), Date.now())
      return "updated"
    }).immediate()
  }

  const client = await getPostgresPool().connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT pg_advisory_xact_lock(hashtext('moemail:init-emperor'))")
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`moemail:user-role:${userId}`],
    )
    const target = await client.query(
      `SELECT id FROM "user" WHERE id = $1 FOR UPDATE`,
      [userId],
    )
    if (target.rowCount !== 1) {
      await client.query("COMMIT")
      return "not_found"
    }

    const emperor = await client.query(`
      SELECT 1
      FROM user_role
      INNER JOIN role ON role.id = user_role.role_id
      WHERE user_role.user_id = $1 AND role.name = 'emperor'
      LIMIT 1
    `, [userId])
    if (override !== null && emperor.rowCount && !isEmperorSafeOverride(override)) {
      await client.query("COMMIT")
      return "emperor_immutable"
    }

    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      ["moemail:access-policies"],
    )
    const stored = await client.query<{ value: string }>(
      "SELECT value FROM site_config WHERE key = $1 FOR UPDATE",
      [CONFIG_KEYS.ACCESS_POLICIES],
    )
    const next = mutate(parseCurrent(stored.rows[0]?.value))
    await client.query(`
      INSERT INTO site_config (key, value, updated_at) VALUES ($1, $2, NOW())
      ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
    `, [CONFIG_KEYS.ACCESS_POLICIES, JSON.stringify(next)])
    await client.query("COMMIT")
    return "updated"
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

function preferredRole(roles: Role[]): Role {
  return allRoles.find(role => roles.includes(role)) ?? ROLES.CIVILIAN
}

function modeBits(mode: DomainAccessMode) {
  return {
    receive: mode === "allow" || mode === "receive",
    send: mode === "allow" || mode === "send",
  }
}

function bitsMode(receive: boolean, send: boolean): DomainAccessMode {
  if (receive && send) return "allow"
  if (receive) return "receive"
  if (send) return "send"
  return "deny"
}

export function domainAccessMode(policy: DomainAccessPolicy, value: unknown): DomainAccessMode {
  const domain = normalizeMailboxDomain(value)
  return domain ? policy.domains[domain] ?? policy.default : "deny"
}

function mergeDomainAccess(policies: DomainAccessPolicy[]): DomainAccessPolicy {
  const domains = new Set(policies.flatMap(policy => Object.keys(policy.domains)))
  const mergeModes = (modes: DomainAccessMode[]) => {
    const bits = modes.map(modeBits)
    return bitsMode(bits.some(item => item.receive), bits.some(item => item.send))
  }
  return {
    default: mergeModes(policies.map(policy => policy.default)),
    domains: Object.fromEntries([...domains].map(domain => [
      domain,
      mergeModes(policies.map(policy => domainAccessMode(policy, domain))),
    ])),
  }
}

function mergeRolePolicies(policies: AccessPolicies, roles: Role[]): EffectiveAccessPolicy {
  const selectedRole = preferredRole(roles)
  if (selectedRole === ROLES.EMPEROR) {
    return {
      permissions: { ...EMPEROR_ACCESS_POLICY.permissions },
      quotas: { ...EMPEROR_ACCESS_POLICY.quotas },
      domainAccess: allDomainAccess(),
      allowedDomains: null,
      mailQuotaRules: structuredClone(policies.mailQuotaRules.filter(rule => (
        (rule.subject.type === "all" && !rule.ignoreEmperor)
        || (rule.subject.type === "role" && rule.subject.role === ROLES.EMPEROR)
      ))),
      quotaRole: ROLES.EMPEROR,
      roles: [ROLES.EMPEROR],
    }
  }

  const configuredRoles = roles.filter(
    (role): role is typeof nonEmperorRoles[number] => nonEmperorRoles.includes(role as typeof nonEmperorRoles[number]),
  )
  const selected = configuredRoles.length > 0
    ? configuredRoles.map(role => policies.roles[role])
    : [policies.roles[ROLES.CIVILIAN]]

  const permissions = noPermissions()
  for (const permission of Object.values(PERMISSIONS)) {
    permissions[permission] = selected.some(policy => policy.permissions[permission])
  }

  const quotas = {} as AccessQuotas
  for (const quota of QUOTA_KEYS) {
    const values = selected.map(policy => policy.quotas[quota])
    quotas[quota] = values.includes(0) ? 0 : Math.max(...values)
  }
  return {
    permissions,
    quotas,
    domainAccess: mergeDomainAccess(selected.map(policy => policy.domainAccess)),
    allowedDomains: (() => {
      const merged = mergeDomainAccess(selected.map(policy => policy.domainAccess))
      return merged.default === "allow" || merged.default === "receive" || merged.default === "send"
        ? null
        : Object.entries(merged.domains).flatMap(([domain, mode]) => mode === "deny" ? [] : [domain])
    })(),
    mailQuotaRules: structuredClone(policies.mailQuotaRules.filter(rule => (
      rule.subject.type === "all"
      || (rule.subject.type === "role" && rule.subject.role === selectedRole)
    ))),
    quotaRole: selectedRole,
    roles: configuredRoles.length > 0 ? configuredRoles : [ROLES.CIVILIAN],
  }
}

function applyDomainAccessOverride(
  base: DomainAccessPolicy,
  override?: DomainAccessOverride,
): DomainAccessPolicy {
  if (!override) return base
  const replacesPolicy = override.default !== undefined
  return {
    default: override.default ?? base.default,
    domains: replacesPolicy
      ? { ...override.domains }
      : { ...base.domains, ...override.domains },
  }
}

export function resolveAccessPolicy(
  policies: AccessPolicies,
  userId: string,
  roles: Role[],
): EffectiveAccessPolicy {
  const effective = mergeRolePolicies(policies, roles)
  const override = policies.users[userId]
  const userQuotaRules = policies.mailQuotaRules.filter(rule => (
    rule.subject.type === "user" && rule.subject.userId === userId
  ))
  if (!override) return { ...effective, mailQuotaRules: [...effective.mailQuotaRules, ...structuredClone(userQuotaRules)] }

  if (roles.includes(ROLES.EMPEROR)) {
    return {
      ...effective,
      mailQuotaRules: [...effective.mailQuotaRules, ...structuredClone(userQuotaRules)],
    }
  }

  return {
    permissions: { ...effective.permissions, ...override.permissions },
    quotas: { ...effective.quotas, ...override.quotas },
    domainAccess: applyDomainAccessOverride(effective.domainAccess, override.domainAccess),
    allowedDomains: (() => {
      const access = applyDomainAccessOverride(effective.domainAccess, override.domainAccess)
      return access.default === "deny"
        ? Object.entries(access.domains).flatMap(([domain, mode]) => mode === "deny" ? [] : [domain])
        : null
    })(),
    mailQuotaRules: [...effective.mailQuotaRules, ...structuredClone(userQuotaRules)],
    quotaRole: effective.quotaRole,
    roles: effective.roles,
  }
}

export function resolveRoleAccessPolicy(
  policies: AccessPolicies,
  role: Role,
): EffectiveAccessPolicy {
  return mergeRolePolicies(policies, [role])
}

export function resolveQuotaPreviewAccessPolicy(
  policies: AccessPolicies,
  userId: string,
  roles: Role[],
) {
  return resolveAccessPolicy(policies, userId, roles)
}

export async function getEffectiveAccessPolicy(userId: string, roles: Role[]) {
  const policies = await getAccessPolicies()
  return resolveAccessPolicy(policies, userId, roles)
}

export function isDomainOperationAllowed(
  access: EffectiveAccessPolicy,
  value: unknown,
  direction: MailDirection,
) {
  const bits = modeBits(domainAccessMode(access.domainAccess, value))
  return bits[direction]
}

/** Whether creating/retaining a mailbox in this domain has any usable direction. */
export function isDomainAllowed(access: EffectiveAccessPolicy, value: unknown) {
  const mode = domainAccessMode(access.domainAccess, value)
  return mode !== "deny"
}

function subjectSpecificity(subject: MailQuotaSubject) {
  return subject.type === "user" ? 2 : subject.type === "role" ? 1 : 0
}

function targetSpecificity(target: MailQuotaTarget) {
  return target.type === "mailbox" ? 2 : target.type === "domain" ? 1 : 0
}

export function resolveMailQuotaAssignment(
  access: EffectiveAccessPolicy,
  direction: MailDirection,
  value: unknown,
) {
  const selected = resolveMailQuotaAssignments(access, direction, value)
  return selected.find(rule => rule.subject.type !== "all") ?? selected[0]
}

function targetMatches(target: MailQuotaTarget, address: string, domain: string) {
  return target.type === "all"
    || (target.type === "domain" && target.domain === domain)
    || (target.type === "mailbox" && target.address === address)
}

function mostSpecificTarget(rules: MailQuotaAssignment[]) {
  return [...rules].sort((left, right) => (
    targetSpecificity(right.target) - targetSpecificity(left.target)
    || left.id.localeCompare(right.id)
  ))[0]
}

/** Returns the shared global rule first and the effective user/role rule
 * second. At most one rule in each layer can apply to a message. */
export function resolveMailQuotaAssignments(
  access: EffectiveAccessPolicy,
  direction: MailDirection,
  value: unknown,
) {
  const address = normalizeMailboxAddress(value)
  if (!address) return []
  const domain = address.slice(address.lastIndexOf("@") + 1)
  const matching = access.mailQuotaRules.filter(rule => (
    rule.direction === direction && targetMatches(rule.target, address, domain)
  ))
  const global = mostSpecificTarget(matching.filter(rule => rule.subject.type === "all"))
  const scoped = matching
    .filter(rule => rule.subject.type !== "all")
    .sort((left, right) => (
      subjectSpecificity(right.subject) - subjectSpecificity(left.subject)
      || targetSpecificity(right.target) - targetSpecificity(left.target)
      || left.id.localeCompare(right.id)
    ))[0]
  return [global, scoped].filter((rule): rule is MailQuotaAssignment => Boolean(rule))
}

function assignmentProbeAddress(
  assignment: MailQuotaAssignment,
  rules: MailQuotaAssignment[],
) {
  if (assignment.target.type === "mailbox") return assignment.target.address
  const domain = assignment.target.type === "domain"
    ? assignment.target.domain
    : (() => {
      const occupied = new Set(rules.flatMap(rule => (
        rule.target.type === "domain"
          ? [rule.target.domain]
          : rule.target.type === "mailbox" ? [rule.target.address.slice(rule.target.address.lastIndexOf("@") + 1)] : []
      )))
      let suffix = 0
      while (occupied.has(`quota-probe-${suffix}.invalid`)) suffix += 1
      return `quota-probe-${suffix}.invalid`
    })()
  const exactAddresses = new Set(rules.flatMap(rule => rule.target.type === "mailbox" ? [rule.target.address] : []))
  let localPart = "__quota_probe__"
  while (exactAddresses.has(`${localPart}@${domain}`)) localPart += "_"
  return `${localPart}@${domain}`
}

/** Removes rules that can never win for this effective user/role view. */
export function effectiveMailQuotaAssignments(
  access: EffectiveAccessPolicy,
  direction: MailDirection,
) {
  const rules = access.mailQuotaRules.filter(rule => rule.direction === direction)
  return rules.filter(rule => (
    resolveMailQuotaAssignments(access, direction, assignmentProbeAddress(rule, rules)).some(selected => selected.id === rule.id)
  ))
}

export function quotaAssignmentScope(assignment: MailQuotaAssignment) {
  return assignment.target.type
}

export function parseUserAccessOverride(input: unknown): UserAccessOverride {
  return userOverrideSchema.parse(input)
}

export function isEmperorSafeOverride(override: UserAccessOverride) {
  return Object.keys(override.permissions).length === 0
    && Object.keys(override.quotas).length === 0
    && override.domainAccess === undefined
}

export function parseAccessPolicies(input: unknown): AccessPolicies {
  return parseStoredAccessPolicies(input)
}

export function accessPolicyIssues(error: unknown) {
  if (!(error instanceof z.ZodError)) return []
  return error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message }))
}
