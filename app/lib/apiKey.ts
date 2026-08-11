import { and, eq, gt } from "drizzle-orm"
import { createDb } from "./db"
import { apiKeys, roles, userRoles, users } from "./schema"
import { ROLES, type Role } from "./permissions"

export interface ApiKeyPrincipal {
  userId: string
  roles: Role[]
}

const validRoles = new Set<Role>(Object.values(ROLES))

export async function getApiKeyPrincipal(key: string): Promise<ApiKeyPrincipal | null> {
  const rows = await createDb()
    .select({
      userId: apiKeys.userId,
      roleName: roles.name,
    })
    .from(apiKeys)
    .innerJoin(users, eq(apiKeys.userId, users.id))
    .leftJoin(userRoles, eq(apiKeys.userId, userRoles.userId))
    .leftJoin(roles, eq(userRoles.roleId, roles.id))
    .where(and(
      eq(apiKeys.key, key),
      eq(apiKeys.enabled, true),
      gt(apiKeys.expiresAt, new Date())
    ))

  if (!rows.length) return null

  return {
    userId: rows[0].userId,
    roles: rows.flatMap(({ roleName }) => (
      roleName && validRoles.has(roleName as Role) ? [roleName as Role] : []
    )),
  }
}
