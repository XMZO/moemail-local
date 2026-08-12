import { z } from "zod"
import { CONFIG_KEYS, getConfigValues, setConfigValues } from "./config-store"
import {
  PERMISSIONS,
  ROLES,
  type Permission,
  type Role,
} from "./permissions"

export const QUOTA_KEYS = [
  "maxActiveMailboxes",
  "maxMailboxLifetimeDays",
  "dailySendLimit",
  "dailyReceiveLimit",
  "maxMessageBytes",
] as const

export type QuotaKey = typeof QUOTA_KEYS[number]
export type AccessQuotas = Record<QuotaKey, number>
export type PermissionMap = Record<Permission, boolean>

export interface EffectiveAccessPolicy {
  permissions: PermissionMap
  quotas: AccessQuotas
}

const permissionShape = Object.fromEntries(
  Object.values(PERMISSIONS).map(permission => [permission, z.boolean()]),
) as Record<Permission, z.ZodBoolean>

const permissionOverridesSchema = z.object(permissionShape).partial().strict()

const quotaShape = {
  maxActiveMailboxes: z.number().int().min(0).max(100_000),
  maxMailboxLifetimeDays: z.number().int().min(0).max(36_500),
  dailySendLimit: z.number().int().min(0).max(1_000_000),
  dailyReceiveLimit: z.number().int().min(0).max(10_000_000),
  maxMessageBytes: z.number().int().min(0).max(25 * 1024 * 1024),
} satisfies Record<QuotaKey, z.ZodNumber>

const quotaOverridesSchema = z.object(quotaShape).partial().strict()
const completeRolePolicySchema = z.object({
  permissions: z.object(permissionShape).strict(),
  quotas: z.object(quotaShape).strict(),
}).strict()
const userOverrideSchema = z.object({
  permissions: permissionOverridesSchema.default({}),
  quotas: quotaOverridesSchema.default({}),
}).strict()

const nonEmperorRoles = [ROLES.DUKE, ROLES.KNIGHT, ROLES.CIVILIAN] as const
const accessPoliciesSchema = z.object({
  version: z.literal(1),
  roles: z.object({
    [ROLES.DUKE]: completeRolePolicySchema,
    [ROLES.KNIGHT]: completeRolePolicySchema,
    [ROLES.CIVILIAN]: completeRolePolicySchema,
  }).strict(),
  users: z.record(
    z.string().min(1).max(128).refine(value => !/[\x00-\x1f\x7f]/.test(value)),
    userOverrideSchema,
  ),
}).strict()

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

export const EMPEROR_ACCESS_POLICY = Object.freeze({
  permissions: Object.freeze(allPermissions()),
  quotas: Object.freeze({
    maxActiveMailboxes: 0,
    maxMailboxLifetimeDays: 0,
    dailySendLimit: 0,
    dailyReceiveLimit: 0,
    maxMessageBytes: 0,
  }),
}) as EffectiveAccessPolicy

function roleDefaults(maxActiveMailboxes: number, sendLimits: { duke: number; knight: number }) {
  const commonMailPermissions = [
    PERMISSIONS.VIEW_EMAIL,
    PERMISSIONS.CREATE_EMAIL,
    PERMISSIONS.DELETE_EMAIL,
    PERMISSIONS.RECEIVE_EMAIL,
    PERMISSIONS.SHARE_EMAIL,
  ] as const

  return {
    [ROLES.DUKE]: {
      permissions: enabledPermissions(
        ...commonMailPermissions,
        ...(sendLimits.duke >= 0 ? [PERMISSIONS.SEND_EMAIL] : []),
        PERMISSIONS.MANAGE_WEBHOOK,
        PERMISSIONS.MANAGE_API_KEY,
      ),
      quotas: {
        maxActiveMailboxes,
        maxMailboxLifetimeDays: 0,
        dailySendLimit: Math.max(0, sendLimits.duke),
        dailyReceiveLimit: 0,
        maxMessageBytes: 25 * 1024 * 1024,
      },
    },
    [ROLES.KNIGHT]: {
      permissions: enabledPermissions(
        ...commonMailPermissions,
        ...(sendLimits.knight >= 0 ? [PERMISSIONS.SEND_EMAIL] : []),
        PERMISSIONS.MANAGE_WEBHOOK,
      ),
      quotas: {
        maxActiveMailboxes,
        maxMailboxLifetimeDays: 0,
        dailySendLimit: Math.max(0, sendLimits.knight),
        dailyReceiveLimit: 0,
        maxMessageBytes: 25 * 1024 * 1024,
      },
    },
    [ROLES.CIVILIAN]: {
      permissions: noPermissions(),
      quotas: {
        maxActiveMailboxes,
        maxMailboxLifetimeDays: 0,
        dailySendLimit: 0,
        dailyReceiveLimit: 0,
        maxMessageBytes: 25 * 1024 * 1024,
      },
    },
  }
}

export function createDefaultAccessPolicies(): AccessPolicies {
  return {
    version: 1,
    roles: roleDefaults(30, { duke: 5, knight: 2 }),
    users: {},
  }
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
      throw new Error("权限策略存储格式已损坏")
    }
    return accessPoliciesSchema.parse(input)
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
    ...createDefaultAccessPolicies(),
    roles: roleDefaults(safePositiveInteger(values.MAX_EMAILS, 30), {
      duke: numberLimit("duke", 5),
      knight: numberLimit("knight", 2),
    }),
  }
}

export async function getAccessPolicies(): Promise<AccessPolicies> {
  return legacyDefaults()
}

export async function saveAccessPolicies(input: unknown): Promise<AccessPolicies> {
  const policies = accessPoliciesSchema.parse(input)
  await setConfigValues({
    [CONFIG_KEYS.ACCESS_POLICIES]: JSON.stringify(policies),
  })
  return policies
}

function mergeRolePolicies(policies: AccessPolicies, roles: Role[]): EffectiveAccessPolicy {
  if (roles.includes(ROLES.EMPEROR)) return EMPEROR_ACCESS_POLICY

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
  return { permissions, quotas }
}

export async function getEffectiveAccessPolicy(
  userId: string,
  roles: Role[],
): Promise<EffectiveAccessPolicy> {
  if (roles.includes(ROLES.EMPEROR)) return EMPEROR_ACCESS_POLICY

  const policies = await getAccessPolicies()
  const effective = mergeRolePolicies(policies, roles)
  const override = policies.users[userId]
  if (!override) return effective

  return {
    permissions: { ...effective.permissions, ...override.permissions },
    quotas: { ...effective.quotas, ...override.quotas },
  }
}

export function parseUserAccessOverride(input: unknown): UserAccessOverride {
  return userOverrideSchema.parse(input)
}

export function parseAccessPolicies(input: unknown): AccessPolicies {
  return accessPoliciesSchema.parse(input)
}

export function accessPolicyIssues(error: unknown) {
  if (!(error instanceof z.ZodError)) return []
  return error.issues.map(issue => ({
    path: issue.path.join("."),
    message: issue.message,
  }))
}
