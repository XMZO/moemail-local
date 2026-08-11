import { NextResponse } from "next/server"
import { hasPermission, ROLES, type Permission, type Role } from "./permissions"
import { isSetupCompleted } from "./config/runtime"

export interface RequestPrincipal {
  userId: string
  roles: Role[]
  kind: "session" | "apiKey"
}

export type AuthorizationResult =
  | { ok: true; principal: RequestPrincipal }
  | { ok: false; response: NextResponse }

interface AuthorizationOptions {
  permission?: Permission
}

const validRoles = new Set<Role>(Object.values(ROLES))

export function setupRequiredResponse() {
  if (isSetupCompleted()) return null

  return NextResponse.json(
    { error: "MoeMail 尚未完成初始化", code: "SETUP_REQUIRED" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  )
}

function supportsApiKey(pathname: string) {
  return pathname === "/api/emails"
    || pathname.startsWith("/api/emails/")
    || pathname === "/api/config"
    || pathname.startsWith("/api/config/")
}

function normalizeRoles(roleNames: Array<string | null | undefined>): Role[] {
  return roleNames.flatMap(roleName => (
    roleName && validRoles.has(roleName as Role) ? [roleName as Role] : []
  ))
}

export async function authorizeRequest(
  request: Request,
  options: AuthorizationOptions = {}
): Promise<AuthorizationResult> {
  const setupRequired = setupRequiredResponse()
  if (setupRequired) {
    return {
      ok: false,
      response: setupRequired,
    }
  }

  const apiKey = request.headers.get("X-API-Key")
  let principal: RequestPrincipal

  if (apiKey !== null) {
    if (!supportsApiKey(new URL(request.url).pathname)) {
      return {
        ok: false,
        response: NextResponse.json({ error: "无权限查看" }, { status: 403 }),
      }
    }

    const { getApiKeyPrincipal } = await import("./apiKey")
    const apiKeyPrincipal = await getApiKeyPrincipal(apiKey)
    if (!apiKeyPrincipal) {
      return {
        ok: false,
        response: NextResponse.json({ error: "无效的 API Key" }, { status: 401 }),
      }
    }

    principal = {
      ...apiKeyPrincipal,
      kind: "apiKey",
    }
  } else {
    const { auth } = await import("./auth")
    const session = await auth()
    if (!session?.user?.id) {
      return {
        ok: false,
        response: NextResponse.json({ error: "未授权" }, { status: 401 }),
      }
    }

    principal = {
      userId: session.user.id,
      roles: normalizeRoles(session.user.roles?.map(role => role.name) ?? []),
      kind: "session",
    }
  }

  if (options.permission && !hasPermission(principal.roles, options.permission)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "权限不足" }, { status: 403 }),
    }
  }

  return { ok: true, principal }
}
