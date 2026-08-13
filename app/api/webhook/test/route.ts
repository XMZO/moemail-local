import { callWebhook } from "@/lib/webhook"
import { WEBHOOK_CONFIG } from "@/config"
import { z } from "zod"
import { EmailMessage } from "@/lib/webhook"
import { authorizeRequest } from "@/lib/request-auth"
import { PERMISSIONS } from "@/lib/permissions"
import { apiError } from "@/lib/api-response"

export const runtime = "nodejs"

const testSchema = z.object({
  url: z.string().url(),
  sample: z.object({
    subject: z.string().trim().min(1).max(200),
    content: z.string().trim().min(1).max(2_000),
    html: z.string().trim().min(1).max(10_000),
  }).strict(),
}).strict()

export async function POST(request: Request) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.MANAGE_WEBHOOK,
  })
  if (!authorization.ok) return authorization.response

  try {
    const body = await request.json()
    const { url, sample } = testSchema.parse(body)

    await callWebhook(url, {
      event: WEBHOOK_CONFIG.EVENTS.NEW_MESSAGE,
      data: {
        emailId: "123456789",
        messageId: '987654321',
        fromAddress: "sender@example.com",
        subject: sample.subject,
        content: sample.content,
        html: sample.html,
        receivedAt: "2023-03-01T12:00:00Z",
        toAddress: "recipient@example.com"
      } as EmailMessage
    })

    return Response.json({ success: true })
  } catch (error) {
    console.error("webhook.test_failed", error)
    return apiError("WEBHOOK_TEST_FAILED", 400)
  }
}
