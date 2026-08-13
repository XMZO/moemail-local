import { PERMISSIONS } from "@/lib/permissions"
import { authorizeRequest } from "@/lib/request-auth"
import { apiError } from "@/lib/api-response"

export const runtime = "nodejs"

async function retired(request: Request) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.MANAGE_CONFIG,
  })
  if (!authorization.ok) return authorization.response
  return apiError("LEGACY_EMAIL_SERVICE_REMOVED", 410, {
    headers: { "Cache-Control": "private, no-store" },
  })
}

export const GET = retired
export const POST = retired
