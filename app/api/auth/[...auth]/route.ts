import { NextRequest } from "next/server"
import {
  authRateLimitHeaders,
  consumeAuthRateLimit,
} from "@/lib/auth-abuse-guard"
import { isSetupCompleted } from "@/lib/config/runtime"

function setupRequired() {
  return Response.json(
    { error: "MoeMail 尚未完成初始化", code: "SETUP_REQUIRED" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  )
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
      errorUrl.searchParams.set("error", "登录请求过于频繁，请稍后重试")
      errorUrl.searchParams.set("code", "rate_limited")

      return Response.json(
        {
          error: "登录请求过于频繁，请稍后重试",
          code: "AUTH_RATE_LIMITED",
          retryAfter: rateLimit.retryAfterSeconds,
          url: errorUrl.toString(),
        },
        { status: 429, headers: authRateLimitHeaders(rateLimit) },
      )
    }
  }

  const { POST: authPost } = await import("@/lib/auth")
  return authPost(request)
}

export const runtime = 'nodejs'
