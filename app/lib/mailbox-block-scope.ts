import { ROLES, type Role } from "./permissions"

export const GLOBAL_MAILBOX_BLOCK_SCOPE = "global"
/** Stored only in mailbox_name_block.domain; never valid in an email address. */
export const ALL_MAILBOX_BLOCK_DOMAINS = "*"
/** Stored only in mailbox_name_block.local_part; never valid in an email address. */
export const ALL_MAILBOX_BLOCK_LOCAL_PARTS = "*"
export const RESERVABLE_MAILBOX_ROLES = [ROLES.DUKE, ROLES.KNIGHT, ROLES.CIVILIAN] as const

export function mailboxUserBlockScope(userId: string) {
  return `user:${userId}`
}

export function mailboxRoleBlockScope(roleNames: Role[]) {
  const allowed = RESERVABLE_MAILBOX_ROLES.filter(role => roleNames.includes(role))
  return `roles:${allowed.join(",")}`
}

export function mailboxBlockAllowedRoles(scopeKey: string): Role[] | null {
  if (!scopeKey.startsWith("roles:")) return null
  const values = scopeKey.slice("roles:".length).split(",").filter(Boolean)
  return RESERVABLE_MAILBOX_ROLES.filter(role => values.includes(role))
}
