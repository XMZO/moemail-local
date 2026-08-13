import { NextRequest } from "next/server"
import {
  authRateLimitHeaders,
  consumeAuthRateLimit,
} from "@/lib/auth-abuse-guard"
import { isSetupCompleted } from "@/lib/config/runtime"
import { apiError } from "@/lib/api-response"

function setupRequired() {
  return apiError("SETUP_REQUIRED", 503, {
    headers: { "Cache-Control": "no-store" },
  })
}

export async function GET(request: NextRequest) {
  if (!isSetupCompleted()) return setupRequired()
  const { GET: authGet } = await import("@/lib/auth")
  return authGet(request)
}

export async function POST(request: NextRequest) {
  if (!isSetupCompleted()) return setupRequired()

  const pathname = new URL(request.url).pathname.replace(/\/+$/, "")
  if (pathname.endsWith("/callback/credentials")) {
    const rateLimit = consumeAuthRateLimit("login", request.headers)
    if (!rateLimit.allowed) {
      const errorUrl = new URL("/api/auth/error", request.url)
      errorUrl.searchParams.set("error", "AUTH_RATE_LIMITED")
      errorUrl.searchParams.set("code", "rate_limited")

      return apiError("AUTH_RATE_LIMITED", 429, {
        headers: authRateLimitHeaders(rateLimit),
        details: {
          retryAfter: rateLimit.retryAfterSeconds,
          url: errorUrl.toString(),
        },
      })
    }
  }

  const { POST: authPost } = await import("@/lib/auth")
  return authPost(request)
}

export const runtime = 'nodejs'
