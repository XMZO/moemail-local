import { getUiFontFamily, saveUiFontFamily, DEFAULT_UI_FONT_FAMILY } from "@/lib/appearance"
import { PERMISSIONS } from "@/lib/permissions"
import { authorizeRequest } from "@/lib/request-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
const headers = { "Cache-Control": "private, no-store" }

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request, { permission: PERMISSIONS.MANAGE_CONFIG })
  if (!authorization.ok) return authorization.response
  try {
    return Response.json({ fontFamily: await getUiFontFamily(), defaultFontFamily: DEFAULT_UI_FONT_FAMILY }, { headers })
  } catch {
    return Response.json({ error: "读取字体配置失败" }, { status: 500, headers })
  }
}

export async function PUT(request: Request) {
  const authorization = await authorizeRequest(request, { permission: PERMISSIONS.MANAGE_CONFIG })
  if (!authorization.ok) return authorization.response
  try {
    const body = await request.json() as { fontFamily?: unknown }
    return Response.json({ ok: true, fontFamily: await saveUiFontFamily(body.fontFamily) }, { headers })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "保存字体配置失败" }, { status: 400, headers })
  }
}
