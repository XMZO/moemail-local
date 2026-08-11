import { getConfigStatus, getPublicRuntimeConfig } from "@/lib/config/runtime"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const headers = {
  "Cache-Control": "public, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
}

/** 只下发浏览器安全字段；密钥和数据库信息永远不会出现在此响应中。 */
export async function GET() {
  const status = getConfigStatus()
  if (status.fatal) {
    return Response.json({ error: "运行配置不可用" }, { status: 503, headers })
  }

  return Response.json({
    config: getPublicRuntimeConfig(),
    revision: status.revision,
  }, { headers })
}
