import { PERMISSIONS } from "@/lib/permissions"
import { authorizeRequest } from "@/lib/request-auth"

export const runtime = "nodejs"

async function retired(request: Request) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.MANAGE_CONFIG,
  })
  if (!authorization.ok) return authorization.response
  return Response.json({
    error: "全局 Resend 配置已由按域发件策略与权限配额取代，请使用 /api/config/domains 和 /api/access-policies。",
  }, { status: 410, headers: { "Cache-Control": "private, no-store" } })
}

export const GET = retired
export const POST = retired
