import { NextResponse } from "next/server"
import { ROLES, type Permission, type Role } from "./permissions"
import { isSetupCompleted } from "./config/runtime"
import {
  getEffectiveAccessPolicy,
  type EffectiveAccessPolicy,
} from "./access-policies"
import { apiError } from "./api-response"

export interface RequestPrincipal {
  userId: string
  roles: Role[]
  kind: "session" | "apiKey"
  access: EffectiveAccessPolicy
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

  return apiError("SETUP_REQUIRED", 503, {
    headers: { "Cache-Control": "no-store" },
  })
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
  let unresolvedPrincipal: Omit<RequestPrincipal, "access">

  if (apiKey !== null) {
    if (!supportsApiKey(new URL(request.url).pathname)) {
      return {
        ok: false,
        response: apiError("API_KEY_ROUTE_FORBIDDEN", 403),
      }
    }

    const { getApiKeyPrincipal } = await import("./apiKey")
    const apiKeyPrincipal = await getApiKeyPrincipal(apiKey)
    if (!apiKeyPrincipal) {
      return {
        ok: false,
        response: apiError("API_KEY_INVALID", 401),
      }
    }

    unresolvedPrincipal = {
      ...apiKeyPrincipal,
      kind: "apiKey",
    }
  } else {
    const { auth } = await import("./auth")
    const session = await auth()
    if (!session?.user?.id) {
      return {
        ok: false,
        response: apiError("UNAUTHORIZED", 401),
      }
    }

    unresolvedPrincipal = {
      userId: session.user.id,
      roles: normalizeRoles(session.user.roles?.map(role => role.name) ?? []),
      kind: "session",
    }
  }

  // Do not trust the session/API-key snapshot: an Emperor may have disabled
  // this account after the credential was issued.
  const { isUserBanned } = await import("./user-status")
  const banned = await isUserBanned(unresolvedPrincipal.userId)
  if (banned === null) {
    return {
      ok: false,
      response: apiError("UNAUTHORIZED", 401),
    }
  }
  if (banned) {
    return {
      ok: false,
      response: apiError("USER_BANNED", 403),
    }
  }

  const principal: RequestPrincipal = {
    ...unresolvedPrincipal,
    access: await getEffectiveAccessPolicy(unresolvedPrincipal.userId, unresolvedPrincipal.roles),
  }

  if (options.permission && !principal.access.permissions[options.permission]) {
    return {
      ok: false,
      response: apiError("PERMISSION_DENIED", 403),
    }
  }

  return { ok: true, principal }
}
