import { createDefaultAccessPolicies, getAccessPolicies, saveAccessPolicies } from "@/lib/access-policies"
import { PERMISSIONS, ROLES } from "@/lib/permissions"
import { authorizeRequest } from "@/lib/request-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const headers = { "Cache-Control": "private, no-store" }

async function authorizeEmperor(request: Request) {
  const authorization = await authorizeRequest(request)
  if (!authorization.ok) return authorization
  if (!authorization.principal.roles.includes(ROLES.EMPEROR)) {
    return {
      ok: false as const,
      response: Response.json({ error: "仅皇帝可以修改权限策略" }, { status: 403, headers }),
    }
  }
  return authorization
}

export async function GET(request: Request) {
  const authorization = await authorizeEmperor(request)
  if (!authorization.ok) return authorization.response

  try {
    return Response.json({
      policies: await getAccessPolicies(),
      defaults: createDefaultAccessPolicies(),
      permissions: Object.values(PERMISSIONS),
    }, { headers })
  } catch (error) {
    console.error("Failed to load access policies:", error)
    return Response.json({ error: "读取权限策略失败" }, { status: 500, headers })
  }
}

export async function PUT(request: Request) {
  const authorization = await authorizeEmperor(request)
  if (!authorization.ok) return authorization.response

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return Response.json({ error: "请求格式无效" }, { status: 400, headers })
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return Response.json({ error: "请求格式无效" }, { status: 400, headers })
  }

  try {
    const current = await getAccessPolicies()
    const roles = (payload as { roles?: unknown }).roles
    const policies = await saveAccessPolicies({ ...current, roles })
    return Response.json({ ok: true, policies }, { headers })
  } catch (error) {
    console.error("Failed to save access policies:", error)
    return Response.json({ error: "权限策略校验或保存失败" }, { status: 400, headers })
  }
}
