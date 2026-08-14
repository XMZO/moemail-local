import { NextResponse } from "next/server"
import { authSchema } from "@/lib/validation"
import {
  AuthWorkloadOverloadedError,
  authRateLimitHeaders,
  consumeAuthRateLimit,
} from "@/lib/auth-abuse-guard"
import { isSetupCompleted } from "@/lib/config/runtime"
import { apiError } from "@/lib/api-response"

export const runtime = "nodejs"

export async function POST(request: Request) {
  if (!isSetupCompleted()) {
    return apiError("SETUP_REQUIRED", 503, {
      headers: { "Cache-Control": "no-store" },
    })
  }

  const rateLimit = consumeAuthRateLimit("register", request.headers)
  if (!rateLimit.allowed) {
    return apiError("AUTH_RATE_LIMITED", 429, {
      headers: authRateLimitHeaders(rateLimit),
      details: { retryAfter: rateLimit.retryAfterSeconds },
    })
  }

  let json: unknown
  try {
    json = await request.json()
  } catch {
    return apiError("INVALID_JSON", 400)
  }

  const parsed = authSchema.safeParse(json)
  if (!parsed.success) {
    return apiError("INVALID_AUTH_INPUT", 400)
  }

  const { username, password, turnstileToken } = parsed.data
  const { register, UsernameAlreadyExistsError } = await import("@/lib/auth")
  const { verifyTurnstileToken } = await import("@/lib/turnstile")

  try {
    const verification = await verifyTurnstileToken(turnstileToken)
    if (!verification.success) {
      return apiError(
        verification.reason === "missing-token"
          ? "TURNSTILE_REQUIRED"
          : "TURNSTILE_FAILED",
        400,
      )
    }

    const user = await register(username, password)
    const { issueRegistrationLoginTicket } = await import("@/lib/registration-login-ticket")
    const registrationTicket = issueRegistrationLoginTicket(username, user.id)

    return NextResponse.json(
      { user, registrationTicket },
      {
        status: 201,
        headers: { "Cache-Control": "no-store" },
      },
    )
  } catch (error) {
    if (error instanceof AuthWorkloadOverloadedError) {
      return apiError("AUTH_CAPACITY_EXCEEDED", 503, {
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": error.retryAfterSeconds.toString(),
        },
      })
    }
    if (error instanceof UsernameAlreadyExistsError) {
      return apiError("USERNAME_ALREADY_EXISTS", 409)
    }
    console.error("auth.registration_failed", error)
    return apiError("REGISTRATION_FAILED", 500)
  }
}
