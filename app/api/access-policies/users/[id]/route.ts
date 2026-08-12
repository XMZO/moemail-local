import { eq } from "drizzle-orm"
import {
  getAccessPolicies,
  parseUserAccessOverride,
  saveAccessPolicies,
} from "@/lib/access-policies"
import { createDb } from "@/lib/db"
import { ROLES } from "@/lib/permissions"
import { authorizeRequest } from "@/lib/request-auth"
import { users } from "@/lib/schema"

export const runtime = "nodejs"

const headers = { "Cache-Control": "private, no-store" }

async function authorizeTarget(request: Request, userId: string) {
  const authorization = await authorizeRequest(request)
  if (!authorization.ok) return authorization
  if (!authorization.principal.roles.includes(ROLES.EMPEROR)) {
    return {
      ok: false as const,
      response: Response.json({ error: "仅皇帝可以修改用户权限" }, { status: 403, headers }),
    }
  }
  if (authorization.principal.userId === userId) {
    return {
      ok: false as const,
      response: Response.json({ error: "皇帝不能修改自己的权限" }, { status: 400, headers }),
    }
  }

  const targetUser = await createDb().query.users.findFirst({
    where: eq(users.id, userId),
    with: { userRoles: { with: { role: true } } },
  })
  if (!targetUser) {
    return {
      ok: false as const,
      response: Response.json({ error: "用户不存在" }, { status: 404, headers }),
    }
  }
  if (targetUser.userRoles.some(item => item.role.name === ROLES.EMPEROR)) {
    return {
      ok: false as const,
      response: Response.json({ error: "皇帝权限是系统不变量，不能覆盖" }, { status: 400, headers }),
    }
  }
  return authorization
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const authorization = await authorizeTarget(request, id)
  if (!authorization.ok) return authorization.response

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return Response.json({ error: "请求格式无效" }, { status: 400, headers })
  }

  try {
    const override = parseUserAccessOverride(payload)
    const policies = await getAccessPolicies()
    policies.users[id] = override
    await saveAccessPolicies(policies)
    return Response.json({ ok: true, override }, { headers })
  } catch (error) {
    console.error("Failed to save user access override:", error)
    return Response.json({ error: "用户权限覆盖校验或保存失败" }, { status: 400, headers })
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const authorization = await authorizeTarget(request, id)
  if (!authorization.ok) return authorization.response

  try {
    const policies = await getAccessPolicies()
    delete policies.users[id]
    await saveAccessPolicies(policies)
    return Response.json({ ok: true }, { headers })
  } catch (error) {
    console.error("Failed to reset user access override:", error)
    return Response.json({ error: "重置用户权限失败" }, { status: 500, headers })
  }
}
