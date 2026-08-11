import {
  getConfig,
  getConfigStatus,
  getSetupRecoveryConfig,
  reloadConfig,
} from "@/lib/config/runtime"
import {
  acquireSetupOperation,
  authorizeSetupRequest,
  completeSetup,
} from "@/lib/setup-service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const noStore = { "Cache-Control": "no-store" }

export async function GET(request: Request) {
  const denied = authorizeSetupRequest(request, { consumeBudget: false })
  if (denied) return denied

  const status = getConfigStatus()
  const defaults = status.fatal || status.setupCompleted ? null : (() => {
    let config
    try {
      config = getConfig()
    } catch {
      config = getSetupRecoveryConfig()
    }
    return {
      server: {
        baseUrl: config.server.baseUrl,
        trustProxyHeaders: config.server.trustProxyHeaders,
        emailPollIntervalMs: config.server.emailPollIntervalMs,
      },
      database: {
        driver: config.database.driver,
        sqlite: { path: config.database.sqlite.path },
        postgres: {
          url: config.database.postgres.url
            ?? "postgresql://moemail@postgres:5432/moemail",
          ssl: config.database.postgres.ssl,
          sslRejectUnauthorized: config.database.postgres.sslRejectUnauthorized,
        },
      },
    }
  })()

  return Response.json({
    setupCompleted: status.setupCompleted,
    configPath: status.path,
    restartRequired: status.restartRequired?.reason ?? null,
    configError: status.fatal ?? null,
    defaults,
  }, { headers: noStore })
}

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
    // 等待跨进程 setup lock 后重新从共享磁盘确认状态。另一 Web 进程
    // 可能已在我们排队期间完成初始化并删除一次性 token。
    await reloadConfig()
    const deniedAfterLock = authorizeSetupRequest(request, { consumeBudget: false })
    if (deniedAfterLock) return deniedAfterLock

    let payload: unknown
    try {
      payload = await request.json()
    } catch {
      return Response.json({ error: "请求格式无效" }, { status: 400, headers: noStore })
    }

    const outcome = await completeSetup(payload)
    if (!outcome.ok) {
      return Response.json(
        { error: outcome.error, issues: outcome.issues ?? [] },
        { status: outcome.status, headers: noStore },
      )
    }

    return Response.json({
      ok: true,
      adminCreated: outcome.adminCreated,
      restartRequired: outcome.restartRequired,
      configPath: outcome.configPath,
      emailIngestSecret: outcome.config.email.ingestSecret,
    }, { headers: noStore })
  } finally {
    release()
  }
}
