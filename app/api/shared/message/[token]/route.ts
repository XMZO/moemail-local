import { createDb } from "@/lib/db"
import { messageShares, messages, emails } from "@/lib/schema"
import { eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { setupRequiredResponse } from "@/lib/request-auth"
import { apiError } from "@/lib/api-response"

export const runtime = "nodejs"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const setupRequired = setupRequiredResponse()
  if (setupRequired) return setupRequired

  const { token } = await params
  const db = createDb()

  try {
    const share = await db.query.messageShares.findFirst({
      where: eq(messageShares.token, token)
    })

    if (!share) {
      return apiError("SHARE_NOT_FOUND", 404)
    }

    if (share.expiresAt && share.expiresAt < new Date()) {
      return apiError("SHARE_EXPIRED", 410)
    }

    const message = await db.query.messages.findFirst({
      where: eq(messages.id, share.messageId)
    })

    if (!message) {
      return apiError("MESSAGE_NOT_FOUND", 404)
    }

    const email = await db.query.emails.findFirst({
      where: eq(emails.id, message.emailId),
      columns: { expiresAt: true },
    })
    if (!email) return apiError("MAILBOX_NOT_FOUND", 404)
    if (email.expiresAt.getTime() <= Date.now()) {
      return apiError("MAILBOX_EXPIRED", 410)
    }

    return NextResponse.json({
      message: {
        id: message.id,
        from_address: message.fromAddress,
        to_address: message.toAddress,
        subject: message.subject,
        content: message.content,
        html: message.html,
        received_at: message.receivedAt,
        sent_at: message.sentAt
      }
    })
  } catch (error) {
    console.error("shared_message.read_failed", error)
    return apiError("MESSAGE_READ_FAILED", 500)
  }
}

