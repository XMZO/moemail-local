import { NextResponse } from "next/server"
import { authSchema } from "@/lib/validation"
import {
  AuthWorkloadOverloadedError,
  authRateLimitHeaders,
  consumeAuthRateLimit,
} from "@/lib/auth-abuse-guard"
import { isSetupCompleted } from "@/lib/config/runtime"

export const runtime = "nodejs"

export async function POST(request: Request) {
  if (!isSetupCompleted()) {
    return NextResponse.json(
      { error: "MoeMail 尚未完成初始化", code: "SETUP_REQUIRED" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    )
  }

  const rateLimit = consumeAuthRateLimit("register", request.headers)
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: "注册请求过于频繁，请稍后重试",
        code: "AUTH_RATE_LIMITED",
        retryAfter: rateLimit.retryAfterSeconds,
      },
      { status: 429, headers: authRateLimitHeaders(rateLimit) },
    )
  }

  let json: unknown
  try {
    json = await request.json()
  } catch {
    return NextResponse.json({ error: "请求体必须是有效的 JSON" }, { status: 400 })
  }

  const parsed = authSchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "输入格式不正确" },
      { status: 400 },
    )
  }

  const { username, password, turnstileToken } = parsed.data
  const { register, UsernameAlreadyExistsError } = await import("@/lib/auth")
  const { verifyTurnstileToken } = await import("@/lib/turnstile")

  try {
    const verification = await verifyTurnstileToken(turnstileToken)
    if (!verification.success) {
      const message = verification.reason === "missing-token"
        ? "请先完成安全验证"
        : "安全验证未通过"
      return NextResponse.json({ error: message }, { status: 400 })
    }

    const user = await register(username, password)

    return NextResponse.json({ user }, { status: 201 })
  } catch (error) {
    if (error instanceof AuthWorkloadOverloadedError) {
      return NextResponse.json(
        { error: "注册服务繁忙，请稍后重试", code: "AUTH_CAPACITY_EXCEEDED" },
        {
          status: 503,
          headers: {
            "Cache-Control": "no-store",
            "Retry-After": error.retryAfterSeconds.toString(),
          },
        },
      )
    }
    if (error instanceof UsernameAlreadyExistsError) {
      return NextResponse.json({ error: error.message }, { status: 409 })
    }
    console.error("Registration failed:", error)
    return NextResponse.json({ error: "注册失败" }, { status: 500 })
  }
}
