import { getConfigStatus, getPublicRuntimeConfig } from "@/lib/config/runtime"
import { apiError } from "@/lib/api-response"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const headers = {
  "Cache-Control": "public, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
}

/** Return browser-safe fields only; secrets and database data stay server-side. */
export async function GET() {
  const status = getConfigStatus()
  if (status.fatal) {
    return apiError("RUNTIME_CONFIG_UNAVAILABLE", 503, { headers })
  }

  return Response.json({
    config: getPublicRuntimeConfig(),
    revision: status.revision,
  }, { headers })
}
