import { eq } from "drizzle-orm"
import { getEffectiveAccessPolicy } from "./access-policies"
import { createDb } from "./db"
import { ROLES, type Role } from "./permissions"
import { roles, userRoles } from "./schema"

const validRoles = new Set<Role>(Object.values(ROLES))

export async function getUserAccessPolicy(userId: string) {
  const roleRows = await createDb()
    .select({ roleName: roles.name })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, userId))
  const roleNames = roleRows.flatMap(({ roleName }) => (
    validRoles.has(roleName as Role) ? [roleName as Role] : []
  ))
  return getEffectiveAccessPolicy(userId, roleNames)
}
