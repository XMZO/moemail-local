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
import { apiError, apiIssues } from "@/lib/api-response"

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
    configError: status.fatal
      ? status.fatal.map(issue => ({ path: issue.path, code: "CONFIG_INVALID" }))
      : null,
    defaults,
  }, { headers: noStore })
}

export async function POST(request: Request) {
  const denied = authorizeSetupRequest(request)
  if (denied) return denied

  if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") {
    return apiError("JSON_CONTENT_TYPE_REQUIRED", 415, { headers: noStore })
  }

  const release = acquireSetupOperation()
  if (!release) {
    return apiError("SETUP_IN_PROGRESS", 409, { headers: noStore })
  }

  try {
    // Recheck shared state after acquiring the cross-process lock because
    // another Web process may have completed setup while this request waited.
    await reloadConfig()
    const deniedAfterLock = authorizeSetupRequest(request, { consumeBudget: false })
    if (deniedAfterLock) return deniedAfterLock

    let payload: unknown
    try {
      payload = await request.json()
    } catch {
      return apiError("INVALID_JSON", 400, { headers: noStore })
    }

    const outcome = await completeSetup(payload)
    if (!outcome.ok) {
      return apiError(outcome.error, outcome.status, {
        headers: noStore,
        details: { issues: apiIssues(outcome.issues ?? []) },
      })
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
