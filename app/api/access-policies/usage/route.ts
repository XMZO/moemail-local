import { eq } from "drizzle-orm"
import {
  getAccessPolicies,
  resolveAccessPolicy,
  resolveRoleAccessPolicy,
} from "@/lib/access-policies"
import { createDb } from "@/lib/db"
import { ROLES, type Role } from "@/lib/permissions"
import { authorizeRequest } from "@/lib/request-auth"
import { users } from "@/lib/schema"
import {
  getRoleMailQuotaUsage,
  getGlobalMailQuotaUsage,
  getUserMailQuotaUsage,
  resetMailQuotaUsage,
} from "@/lib/send-permissions"
import { apiError } from "@/lib/api-response"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const headers = { "Cache-Control": "private, no-store" }
const validRoles = new Set<Role>(Object.values(ROLES))

async function authorizeEmperor(request: Request) {
  const authorization = await authorizeRequest(request)
  if (!authorization.ok) return authorization
  if (!authorization.principal.roles.includes(ROLES.EMPEROR)) {
    return { ok: false as const, response: apiError("EMPEROR_REQUIRED", 403, { headers }) }
  }
  return authorization
}

export async function GET(request: Request) {
  const authorization = await authorizeEmperor(request)
  if (!authorization.ok) return authorization.response

  try {
    const params = new URL(request.url).searchParams
    const role = params.get("role")
    const userId = params.get("userId")
    const scope = params.get("scope")
    const direction = params.get("direction") === "receive" ? "receive" : "send"
    const policies = await getAccessPolicies()
    if (scope === "global") {
      const access = {
        ...resolveRoleAccessPolicy(policies, ROLES.CIVILIAN),
        mailQuotaRules: policies.mailQuotaRules.filter(rule => rule.subject.type === "all"),
      }
      return Response.json({ usage: await getGlobalMailQuotaUsage(access, direction) }, { headers })
    }
    if (role && validRoles.has(role as Role)) {
      const roleName = role as Role
      const access = resolveRoleAccessPolicy(policies, roleName)
      return Response.json({ usage: await getRoleMailQuotaUsage(roleName, access, direction) }, { headers })
    }
    if (!userId) return apiError("INVALID_REQUEST", 400, { headers })

    const target = await createDb().query.users.findFirst({
      where: eq(users.id, userId),
      with: { userRoles: { with: { role: true } } },
    })
    if (!target) return apiError("USER_NOT_FOUND", 404, { headers })
    const userRoleNames = target.userRoles.flatMap(item => (
      validRoles.has(item.role.name as Role) ? [item.role.name as Role] : []
    ))
    const access = resolveAccessPolicy(policies, userId, userRoleNames)
    return Response.json({ usage: await getUserMailQuotaUsage(userId, access, direction) }, { headers })
  } catch (error) {
    console.error("access_policy.usage_read_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    })
    return apiError("MAIL_QUOTA_USAGE_READ_FAILED", 500, { headers })
  }
}

export async function DELETE(request: Request) {
  const authorization = await authorizeEmperor(request)
  if (!authorization.ok) return authorization.response
  const payload = await request.json().catch(() => null) as {
    direction?: unknown
    all?: unknown
    userId?: unknown
    role?: unknown
    mailboxAddress?: unknown
  } | null
  if (
    !payload
    || (payload.direction !== "send" && payload.direction !== "receive")
    || (payload.all !== undefined && typeof payload.all !== "boolean")
    || (payload.userId !== undefined && typeof payload.userId !== "string")
    || (payload.role !== undefined && !validRoles.has(payload.role as Role))
    || (payload.mailboxAddress !== undefined && typeof payload.mailboxAddress !== "string")
    || ([payload.all === true, Boolean(payload.userId), Boolean(payload.role)].filter(Boolean).length !== 1)
  ) return apiError("INVALID_REQUEST", 400, { headers })
  try {
    const deleted = await resetMailQuotaUsage({
      direction: payload.direction,
      all: payload.all === true,
      userId: payload.userId as string | undefined,
      role: payload.role as Role | undefined,
      mailboxAddress: payload.mailboxAddress as string | undefined,
    })
    return Response.json({ ok: true, deleted }, { headers })
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_MAILBOX_ADDRESS") {
      return apiError("INVALID_MAILBOX_NAME", 400, { headers })
    }
    console.error("access_policy.usage_reset_failed", { name: error instanceof Error ? error.name : "UnknownError" })
    return apiError("MAIL_QUOTA_RESET_FAILED", 500, { headers })
  }
}
