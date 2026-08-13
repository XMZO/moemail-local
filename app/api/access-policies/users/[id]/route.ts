import {
  mutateUserAccessOverride,
  parseUserAccessOverride,
} from "@/lib/access-policies"
import { ROLES } from "@/lib/permissions"
import { authorizeRequest } from "@/lib/request-auth"
import { apiError } from "@/lib/api-response"

export const runtime = "nodejs"

const headers = { "Cache-Control": "private, no-store" }

async function authorizeEmperor(request: Request) {
  const authorization = await authorizeRequest(request)
  if (!authorization.ok) return authorization
  if (!authorization.principal.roles.includes(ROLES.EMPEROR)) {
    return {
      ok: false as const,
      response: apiError("EMPEROR_REQUIRED", 403, { headers }),
    }
  }
  return authorization
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const authorization = await authorizeEmperor(request)
  if (!authorization.ok) return authorization.response

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return apiError("INVALID_JSON", 400, { headers })
  }

  try {
    const override = parseUserAccessOverride(payload)
    const result = await mutateUserAccessOverride(id, override)
    if (result === "not_found") {
      return apiError("USER_NOT_FOUND", 404, { headers })
    }
    if (result === "emperor_immutable") {
      return apiError("EMPEROR_POLICY_IMMUTABLE", 400, { headers })
    }
    return Response.json({ ok: true, override }, { headers })
  } catch (error) {
    console.error("access_policy.user_override_save_failed", error)
    return apiError("USER_ACCESS_OVERRIDE_SAVE_FAILED", 400, { headers })
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const authorization = await authorizeEmperor(request)
  if (!authorization.ok) return authorization.response

  try {
    const result = await mutateUserAccessOverride(id, null)
    if (result === "not_found") {
      return apiError("USER_NOT_FOUND", 404, { headers })
    }
    return Response.json({ ok: true }, { headers })
  } catch (error) {
    console.error("access_policy.user_override_reset_failed", error)
    return apiError("USER_ACCESS_OVERRIDE_RESET_FAILED", 500, { headers })
  }
}
