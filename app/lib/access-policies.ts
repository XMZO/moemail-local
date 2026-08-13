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
  sendQuota: MailQuotaPolicy
  sendQuotaRole: Role
  receiveQuota: MailQuotaPolicy
  receiveQuotaRole: Role
}

const permissionShape = Object.fromEntries(
  Object.values(PERMISSIONS).map(permission => [permission, z.boolean()]),
) as Record<Permission, z.ZodBoolean>

const permissionOverridesSchema = z.object(permissionShape).partial().strict()

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
  permissions: z.object(permissionShape).strict(),
  quotas: z.object(legacyQuotaShape).strict(),
}).strict()
const version2CompleteRolePolicySchema = legacyCompleteRolePolicySchema.extend({
  allowedDomains: allowedDomainsSchema,
}).strict()
const version3CompleteRolePolicySchema = z.object({
  permissions: z.object(permissionShape).strict(),
  quotas: z.object(version3QuotaShape).strict(),
  allowedDomains: allowedDomainsSchema,
  sendQuota: version3MailQuotaPolicySchema,
}).strict()

const completeRolePolicySchema = z.object({
  permissions: z.object(permissionShape).strict(),
  quotas: z.object(quotaShape).strict(),
  domainAccess: domainAccessPolicySchema,
  sendQuota: mailQuotaPolicySchema,
  receiveQuota: mailQuotaPolicySchema,
}).strict()

const legacyUserOverrideSchema = z.object({
  permissions: permissionOverridesSchema.default({}),
  quotas: legacyQuotaOverridesSchema.default({}),
}).strict()
const version2UserOverrideSchema = legacyUserOverrideSchema.extend({
  allowedDomains: allowedDomainsSchema.optional(),
}).strict()
const version3UserOverrideSchema = z.object({
  permissions: permissionOverridesSchema.default({}),
  quotas: version3QuotaOverridesSchema.default({}),
  allowedDomains: allowedDomainsSchema.optional(),
  sendQuota: version3MailQuotaOverrideSchema.optional(),
}).strict()
const userOverrideSchema = z.object({
  permissions: permissionOverridesSchema.default({}),
  quotas: quotaOverridesSchema.default({}),
  domainAccess: domainAccessOverrideSchema.optional(),
  sendQuota: mailQuotaOverrideSchema.optional(),
  receiveQuota: mailQuotaOverrideSchema.optional(),
}).strict()

const userIdSchema = z.string().min(1).max(128).refine(value => !/[\x00-\x1f\x7f]/.test(value))
const nonEmperorRoles = [ROLES.DUKE, ROLES.KNIGHT, ROLES.CIVILIAN] as const
const allRoles = [ROLES.EMPEROR, ...nonEmperorRoles] as const

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

const accessPoliciesSchema = z.object({
  version: z.literal(4),
  roles: z.object({
    [ROLES.EMPEROR]: completeRolePolicySchema,
    [ROLES.DUKE]: completeRolePolicySchema,
    [ROLES.KNIGHT]: completeRolePolicySchema,
    [ROLES.CIVILIAN]: completeRolePolicySchema,
  }).strict(),
  users: z.record(userIdSchema, userOverrideSchema),
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
export type UserAccessOverride = z.infer<typeof userOverrideSchema>

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

function mailQuota(total: MailQuotaRule): MailQuotaPolicy {
  return {
    scope: "user",
    total,
    domains: {},
    mailbox: unlimitedMailboxQuotaRule(),
    domainMailboxes: {},
    mailboxes: {},
  }
}

function allDomainAccess(): DomainAccessPolicy {
  return { default: "allow", domains: {} }
}

export const EMPEROR_ACCESS_POLICY = Object.freeze({
  permissions: Object.freeze(allPermissions()),
  quotas: Object.freeze({
    maxActiveMailboxes: 0,
    maxMailboxLifetimeDays: 0,
    maxMessageBytes: 0,
  }),
  domainAccess: Object.freeze(allDomainAccess()),
  allowedDomains: null,
  sendQuota: Object.freeze(mailQuota(unlimitedMailQuotaRule())),
  sendQuotaRole: ROLES.EMPEROR,
  receiveQuota: Object.freeze(mailQuota(unlimitedMailQuotaRule())),
  receiveQuotaRole: ROLES.EMPEROR,
}) as EffectiveAccessPolicy

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
  const rolePolicy = (
    permissions: PermissionMap,
    quotas: AccessQuotas,
    send: MailQuotaRule,
  ) => ({
    permissions,
    quotas,
    domainAccess: allDomainAccess(),
    sendQuota: mailQuota(send),
    receiveQuota: mailQuota(unlimitedMailQuotaRule()),
  })

  return {
    [ROLES.EMPEROR]: rolePolicy(
      allPermissions(),
      generalQuotas({ maxActiveMailboxes: 0, maxMessageBytes: 0 }),
      unlimitedMailQuotaRule(),
    ),
    [ROLES.DUKE]: rolePolicy(
      enabledPermissions(
        ...commonMailPermissions,
        ...(sendLimits.duke >= 0 ? [PERMISSIONS.SEND_EMAIL] : []),
        PERMISSIONS.MANAGE_WEBHOOK,
        PERMISSIONS.MANAGE_API_KEY,
      ),
      generalQuotas(),
      legacyDailySendRule(Math.max(0, sendLimits.duke)),
    ),
    [ROLES.KNIGHT]: rolePolicy(
      enabledPermissions(
        ...commonMailPermissions,
        ...(sendLimits.knight >= 0 ? [PERMISSIONS.SEND_EMAIL] : []),
        PERMISSIONS.MANAGE_WEBHOOK,
      ),
      generalQuotas(),
      legacyDailySendRule(Math.max(0, sendLimits.knight)),
    ),
    [ROLES.CIVILIAN]: rolePolicy(
      noPermissions(),
      generalQuotas(),
      disabledMailQuotaRule(),
    ),
  } satisfies AccessPolicies["roles"]
}

export function createDefaultAccessPolicies(): AccessPolicies {
  return {
    version: 4,
    roles: roleDefaults(30, { duke: 5, knight: 2 }),
    users: {},
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
    sendQuota: mailQuota(legacyDailySendRule(dailySendLimit)),
    receiveQuota: mailQuota(legacyDailyReceiveRule(dailyReceiveLimit)),
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
    receiveQuota: mailQuota(legacyDailyReceiveRule(dailyReceiveLimit)),
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

function parseStoredAccessPolicies(input: unknown): AccessPolicies {
  const version = typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as { version?: unknown }).version
    : undefined
  if (version === 1) {
    const legacy = legacyAccessPoliciesSchema.parse(input)
    return accessPoliciesSchema.parse({
      version: 4,
      roles: {
        [ROLES.EMPEROR]: createDefaultAccessPolicies().roles[ROLES.EMPEROR],
        ...Object.fromEntries(nonEmperorRoles.map(role => [role, migrateLegacyRole(legacy.roles[role])])),
      },
      users: Object.fromEntries(Object.entries(legacy.users).map(([id, user]) => [id, migrateLegacyUser(user)])),
    })
  }
  if (version === 2) {
    const legacy = version2AccessPoliciesSchema.parse(input)
    return accessPoliciesSchema.parse({
      version: 4,
      roles: {
        [ROLES.EMPEROR]: createDefaultAccessPolicies().roles[ROLES.EMPEROR],
        ...Object.fromEntries(nonEmperorRoles.map(role => [role, migrateLegacyRole(legacy.roles[role])])),
      },
      users: Object.fromEntries(Object.entries(legacy.users).map(([id, user]) => [id, migrateLegacyUser(user)])),
    })
  }
  if (version === 3) {
    const legacy = version3AccessPoliciesSchema.parse(input)
    return accessPoliciesSchema.parse({
      version: 4,
      roles: Object.fromEntries(allRoles.map(role => [role, migrateVersion3Role(legacy.roles[role])])),
      users: Object.fromEntries(Object.entries(legacy.users).map(([id, user]) => [id, migrateVersion3User(user)])),
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
  if (!(userId in policies.users)) return stored
  const policyUsers = { ...policies.users }
  delete policyUsers[userId]
  return JSON.stringify(accessPoliciesSchema.parse({ ...policies, users: policyUsers }))
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

  return {
    version: 4,
    roles: roleDefaults(safePositiveInteger(values.MAX_EMAILS, 30), {
      duke: numberLimit("duke", 5),
      knight: numberLimit("knight", 2),
    }),
    users: {},
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
      sendQuota: structuredClone(policies.roles[ROLES.EMPEROR].sendQuota),
      sendQuotaRole: ROLES.EMPEROR,
      receiveQuota: structuredClone(policies.roles[ROLES.EMPEROR].receiveQuota),
      receiveQuotaRole: ROLES.EMPEROR,
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
  const rolePolicy = policies.roles[selectedRole]
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
    sendQuota: structuredClone(rolePolicy.sendQuota),
    sendQuotaRole: selectedRole,
    receiveQuota: structuredClone(rolePolicy.receiveQuota),
    receiveQuotaRole: selectedRole,
  }
}

function aggregateQuotaOverrideCustomized(override?: MailQuotaOverride) {
  return Boolean(override && (
    override.total !== undefined
    || Object.keys(override.domains ?? {}).length > 0
  ))
}

function applyMailQuotaOverride(base: MailQuotaPolicy, override?: MailQuotaOverride): MailQuotaPolicy {
  if (!override) return base
  return {
    // Mailbox counters are always keyed by the concrete user and address in
    // send-permissions.ts. A mailbox-only override must therefore preserve a
    // role-shared aggregate policy instead of silently turning total/domain
    // counters into personal counters.
    scope: aggregateQuotaOverrideCustomized(override) ? "user" : base.scope,
    total: override.total ?? base.total,
    domains: { ...base.domains, ...override.domains },
    mailbox: override.mailbox ?? base.mailbox ?? unlimitedMailboxQuotaRule(),
    domainMailboxes: { ...(base.domainMailboxes ?? {}), ...override.domainMailboxes },
    mailboxes: { ...(base.mailboxes ?? {}), ...override.mailboxes },
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
  if (!override) return effective

  if (roles.includes(ROLES.EMPEROR)) {
    return {
      ...effective,
      sendQuota: applyMailQuotaOverride(effective.sendQuota, override.sendQuota),
      receiveQuota: applyMailQuotaOverride(effective.receiveQuota, override.receiveQuota),
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
    sendQuota: applyMailQuotaOverride(effective.sendQuota, override.sendQuota),
    sendQuotaRole: effective.sendQuotaRole,
    receiveQuota: applyMailQuotaOverride(effective.receiveQuota, override.receiveQuota),
    receiveQuotaRole: effective.receiveQuotaRole,
  }
}

export function resolveRoleAccessPolicy(
  policies: AccessPolicies,
  role: Role,
): EffectiveAccessPolicy {
  return mergeRolePolicies(policies, [role])
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

export function mailQuotaForDirection(access: EffectiveAccessPolicy, direction: MailDirection) {
  return direction === "send" ? access.sendQuota : access.receiveQuota
}

export function mailQuotaRoleForDirection(access: EffectiveAccessPolicy, direction: MailDirection) {
  return direction === "send" ? access.sendQuotaRole : access.receiveQuotaRole
}

export function mailQuotaRuleForDomain(
  access: EffectiveAccessPolicy,
  direction: MailDirection,
  value: unknown,
) {
  const domain = normalizeMailboxDomain(value)
  const quota = mailQuotaForDirection(access, direction)
  return domain ? quota.domains[domain] ?? unlimitedMailQuotaRule() : unlimitedMailQuotaRule()
}

export function sendQuotaRuleForDomain(access: EffectiveAccessPolicy, value: unknown) {
  return mailQuotaRuleForDomain(access, "send", value)
}

export function mailboxQuotaRuleForAddress(
  access: EffectiveAccessPolicy,
  direction: MailDirection,
  value: unknown,
) {
  const address = normalizeMailboxAddress(value)
  const quota = mailQuotaForDirection(access, direction)
  if (!address) return quota.mailbox ?? unlimitedMailboxQuotaRule()
  const domain = address.slice(address.lastIndexOf("@") + 1)
  return quota.mailboxes?.[address]
    ?? quota.domainMailboxes?.[domain]
    ?? quota.mailbox
    ?? unlimitedMailboxQuotaRule()
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
