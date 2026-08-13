import { getAppearanceConfig, saveAppearanceConfig, DEFAULT_UI_FONT_FAMILY } from "@/lib/appearance"
import { PERMISSIONS, ROLES } from "@/lib/permissions"
import { authorizeRequest } from "@/lib/request-auth"
import { apiError } from "@/lib/api-response"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
const headers = { "Cache-Control": "private, no-store" }

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request, { permission: PERMISSIONS.MANAGE_CONFIG })
  if (!authorization.ok) return authorization.response
  try {
    const appearance = await getAppearanceConfig()
    const advancedEditable = authorization.principal.roles.includes(ROLES.EMPEROR)
    return Response.json({
      fontFamily: appearance.fontFamily,
      ...(advancedEditable ? appearance : {}),
      defaultFontFamily: DEFAULT_UI_FONT_FAMILY,
      advancedEditable,
    }, { headers })
  } catch {
    return apiError("APPEARANCE_READ_FAILED", 500, { headers })
  }
}

export async function PUT(request: Request) {
  const authorization = await authorizeRequest(request, { permission: PERMISSIONS.MANAGE_CONFIG })
  if (!authorization.ok) return authorization.response
  try {
    const body = await request.json() as Record<string, unknown>
    const advancedKeys = ["advancedEnabled", "customCss", "headHtml", "bodyEndHtml", "customJs", "customJsEnabled"]
    if (
      !authorization.principal.roles.includes(ROLES.EMPEROR)
      && advancedKeys.some(key => Object.prototype.hasOwnProperty.call(body, key))
    ) {
      return apiError("EMPEROR_REQUIRED", 403, { headers })
    }
    return Response.json({ ok: true, ...await saveAppearanceConfig(body) }, { headers })
  } catch (error) {
    console.error("appearance.save_failed", error)
    return apiError("APPEARANCE_SAVE_FAILED", 400, { headers })
  }
}
