import { probeDatabase } from "@/lib/database-setup"
import { reloadConfig } from "@/lib/config/runtime"
import {
  acquireSetupOperation,
  authorizeSetupRequest,
  buildCandidateConfig,
  buildSetupConfigPatch,
} from "@/lib/setup-service"
import { apiError, apiIssues } from "@/lib/api-response"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const noStore = { "Cache-Control": "no-store" }

/** Probe connectivity for the setup wizard without writing configuration. */
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
    await reloadConfig()
    const deniedAfterLock = authorizeSetupRequest(request, { consumeBudget: false })
    if (deniedAfterLock) return deniedAfterLock

    let payload: unknown
    try {
      payload = await request.json()
    } catch {
      return apiError("INVALID_JSON", 400, { headers: noStore })
    }

    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return apiError("INVALID_REQUEST", 400, { headers: noStore })
    }

    const patch = buildSetupConfigPatch(payload as Record<string, unknown>)
    if (!patch.ok) {
      return apiError("ADVANCED_YAML_INVALID", 400, {
        headers: noStore,
        details: { ok: false, issues: apiIssues(patch.issues) },
      })
    }

    const candidate = buildCandidateConfig(patch.patch, { completed: false })
    if (!candidate.ok) {
      return apiError("CONFIG_VALIDATION_FAILED", 400, {
        headers: noStore,
        details: { ok: false, issues: apiIssues(candidate.issues) },
      })
    }

    const issues = await probeDatabase(candidate.config)
    if (issues.length > 0) {
      return apiError("DATABASE_PROBE_FAILED", 400, {
        headers: noStore,
        details: { ok: false, issues: apiIssues(issues) },
      })
    }

    return Response.json({
      ok: true,
      driver: candidate.config.database.driver,
    }, { headers: noStore })
  } finally {
    release()
  }
}
