import { probeDatabase } from "@/lib/database-setup"
import { reloadConfig } from "@/lib/config/runtime"
import {
  acquireSetupOperation,
  authorizeSetupRequest,
  buildCandidateConfig,
  buildSetupConfigPatch,
} from "@/lib/setup-service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const noStore = { "Cache-Control": "no-store" }

/** 初始化向导中的「测试连接」：只做连通性验证，不写配置文件。 */
export async function POST(request: Request) {
  const denied = authorizeSetupRequest(request)
  if (denied) return denied

  if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") {
    return Response.json({ error: "请求必须使用 application/json" }, {
      status: 415,
      headers: noStore,
    })
  }

  const release = acquireSetupOperation()
  if (!release) {
    return Response.json({ error: "另一个初始化操作正在进行，请稍后重试" }, {
      status: 409,
      headers: noStore,
    })
  }

  try {
    await reloadConfig()
    const deniedAfterLock = authorizeSetupRequest(request, { consumeBudget: false })
    if (deniedAfterLock) return deniedAfterLock

    let payload: unknown
    try {
      payload = await request.json()
    } catch {
      return Response.json({ error: "请求格式无效" }, { status: 400, headers: noStore })
    }

    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return Response.json({ error: "请求格式无效" }, { status: 400, headers: noStore })
    }

    const patch = buildSetupConfigPatch(payload as Record<string, unknown>)
    if (!patch.ok) {
      return Response.json(
        { ok: false, error: "高级 YAML 解析失败", issues: patch.issues },
        { status: 400, headers: noStore },
      )
    }

    const candidate = buildCandidateConfig(patch.patch, { completed: false })
    if (!candidate.ok) {
      return Response.json(
        { ok: false, error: "配置校验未通过", issues: candidate.issues },
        { status: 400, headers: noStore },
      )
    }

    const issues = await probeDatabase(candidate.config)
    if (issues.length > 0) {
      return Response.json(
        { ok: false, error: "数据库连接失败", issues },
        { status: 400, headers: noStore },
      )
    }

    return Response.json({
      ok: true,
      driver: candidate.config.database.driver,
    }, { headers: noStore })
  } finally {
    release()
  }
}
