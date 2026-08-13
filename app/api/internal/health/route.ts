import { sql } from "drizzle-orm"
import { getConfigStatus } from "@/lib/config/runtime"
import { createDb, getDatabaseDriver } from "@/lib/db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const noStore = { "Cache-Control": "no-store" }

export async function GET() {
  const status = getConfigStatus()

  if (status.fatal) {
    return Response.json({
      // Keep the recovery wizard reachable and never expose parser details,
      // secrets, or local paths through this anonymous health endpoint.
      status: "config-recovery-required",
      reason: "config-invalid",
    }, { headers: noStore })
  }

  // Setup-required is a healthy recoverable state, not a database failure.
  if (!status.setupCompleted) {
    return Response.json({
      status: "setup-required",
    }, { headers: noStore })
  }

  try {
    await createDb().select({ ok: sql<number>`1` })
    return Response.json({
      status: "ok",
      database: getDatabaseDriver(),
      configRevision: status.revision,
      restartRequired: status.restartRequired?.reason ?? null,
      configError: status.lastError ? "invalid-change-rejected" : null,
    }, { headers: noStore })
  } catch (error) {
    console.error("health.database_check_failed", error)
    return Response.json({ status: "unhealthy", reason: "database" }, {
      status: 503,
      headers: noStore,
    })
  }
}
