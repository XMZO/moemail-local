import { createHash, timingSafeEqual } from "node:crypto"
import { claimEmperor } from "@/lib/emperor"
import { authorizeRequest } from "@/lib/request-auth"
import { getConfig } from "@/lib/config/runtime"
import { apiError } from "@/lib/api-response"

export const runtime = "nodejs"

function secretMatches(supplied: string, expected: string) {
  const suppliedDigest = createHash("sha256").update(supplied).digest()
  const expectedDigest = createHash("sha256").update(expected).digest()
  return timingSafeEqual(suppliedDigest, expectedDigest)
}

export async function POST(request: Request) {
  const authorization = await authorizeRequest(request)
  if (!authorization.ok) return authorization.response

  const expectedSecret = getConfig().auth.emperorBootstrapSecret
  if (!expectedSecret) {
    return apiError("EMPEROR_BOOTSTRAP_DISABLED", 503)
  }

  let suppliedSecret = ""
  try {
    const body = await request.json() as { secret?: unknown }
    suppliedSecret = typeof body.secret === "string" ? body.secret : ""
  } catch {
    return apiError("INVALID_JSON", 400)
  }

  if (!secretMatches(suppliedSecret, expectedSecret)) {
    return apiError("EMPEROR_BOOTSTRAP_SECRET_INVALID", 401)
  }

  try {
    const result = await claimEmperor(authorization.principal.userId)
    if (result === "emperor_exists") {
      return apiError("EMPEROR_ALREADY_EXISTS", 409)
    }
    return Response.json({
      success: true,
      code: result === "already_emperor" ? "ALREADY_EMPEROR" : "EMPEROR_CLAIMED",
    })
  } catch (error) {
    console.error("role.emperor_claim_failed", error)
    return apiError("EMPEROR_CLAIM_FAILED", 500)
  }
}
