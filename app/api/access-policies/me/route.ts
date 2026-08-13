import { and, count, eq, gt, isNull, or } from "drizzle-orm"
import { apiError } from "@/lib/api-response"
import { createDb } from "@/lib/db"
import { authorizeRequest } from "@/lib/request-auth"
import { apiKeys, emails } from "@/lib/schema"
import { getUserMailQuotaUsage } from "@/lib/send-permissions"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const headers = { "Cache-Control": "private, no-store" }

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request)
  if (!authorization.ok) return authorization.response
  if (authorization.principal.kind !== "session") return apiError("API_KEY_ROUTE_FORBIDDEN", 403, { headers })

  try {
    const { userId, access } = authorization.principal
    const db = createDb()
    const [activeMailboxRows, activeApiKeyRows, send, receive] = await Promise.all([
      db.select({ value: count() }).from(emails).where(and(
        eq(emails.userId, userId),
        gt(emails.expiresAt, new Date()),
      )),
      db.select({ value: count() }).from(apiKeys).where(and(
        eq(apiKeys.userId, userId),
        eq(apiKeys.enabled, true),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
      )),
      getUserMailQuotaUsage(userId, access, "send"),
      getUserMailQuotaUsage(userId, access, "receive"),
    ])

    return Response.json({
      access: {
        quotas: access.quotas,
        mailQuotaRules: access.mailQuotaRules,
      },
      usage: {
        activeMailboxes: Number(activeMailboxRows[0]?.value ?? 0),
        activeApiKeys: Number(activeApiKeyRows[0]?.value ?? 0),
        send,
        receive,
      },
    }, { headers })
  } catch (error) {
    console.error("access_policy.self_read_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    })
    return apiError("MAIL_QUOTA_USAGE_READ_FAILED", 500, { headers })
  }
}
