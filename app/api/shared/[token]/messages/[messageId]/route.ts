import { createDb } from "@/lib/db"
import { emailShares, messages } from "@/lib/schema"
import { and, eq, isNull, ne, or } from "drizzle-orm"
import { NextResponse } from "next/server"
import { setupRequiredResponse } from "@/lib/request-auth"
import { apiError } from "@/lib/api-response"

export const runtime = "nodejs"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string; messageId: string }> }
) {
  const setupRequired = setupRequiredResponse()
  if (setupRequired) return setupRequired

  const { token, messageId } = await params
  const db = createDb()

  try {
    const share = await db.query.emailShares.findFirst({
      where: eq(emailShares.token, token),
      with: {
        email: true
      }
    })

    if (!share) {
      return apiError("SHARE_NOT_FOUND", 404)
    }

    if (share.expiresAt && share.expiresAt < new Date()) {
      return apiError("SHARE_EXPIRED", 410)
    }

    if (share.email.expiresAt < new Date()) {
      return apiError("MAILBOX_EXPIRED", 410)
    }

    const message = await db.query.messages.findFirst({
      where: and(
        eq(messages.id, messageId),
        eq(messages.emailId, share.email.id),
        or(
          ne(messages.type, "sent"),
          isNull(messages.type),
        ),
      )
    })

    if (!message) {
      return apiError("MESSAGE_NOT_FOUND", 404)
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
    console.error("shared_mailbox.message_read_failed", error)
    return apiError("MESSAGE_READ_FAILED", 500)
  }
}

