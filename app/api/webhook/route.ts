import { createDb } from "@/lib/db"
import { webhooks } from "@/lib/schema"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { authorizeRequest } from "@/lib/request-auth"
import { PERMISSIONS } from "@/lib/permissions"
import { validateWebhookUrl } from "@/lib/webhook"
import { apiError } from "@/lib/api-response"

export const runtime = "nodejs"

const webhookSchema = z.object({
  url: z.string().url(),
  enabled: z.boolean()
})

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.MANAGE_WEBHOOK,
  })
  if (!authorization.ok) return authorization.response

  const db = createDb()
  const webhook = await db.query.webhooks.findFirst({
    where: eq(webhooks.userId, authorization.principal.userId)
  })

  return Response.json(webhook || { enabled: false, url: "" })
}

export async function POST(request: Request) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.MANAGE_WEBHOOK,
  })
  if (!authorization.ok) return authorization.response

  const { userId } = authorization.principal

  try {
    const body = await request.json()
    const { url, enabled } = webhookSchema.parse(body)
    await validateWebhookUrl(url)
    
    const db = createDb()
    const now = new Date()

    const existingWebhook = await db.query.webhooks.findFirst({
      where: eq(webhooks.userId, userId)
    })

    if (existingWebhook) {
      await db
        .update(webhooks)
        .set({
          url,
          enabled,
          updatedAt: now
        })
        .where(eq(webhooks.userId, userId))
    } else {
      await db
        .insert(webhooks)
        .values({
          userId,
          url,
          enabled,
        })
    }

    return Response.json({ success: true })
  } catch (error) {
    console.error("webhook.save_failed", error)
    return apiError("WEBHOOK_CONFIG_INVALID", 400)
  }
}
