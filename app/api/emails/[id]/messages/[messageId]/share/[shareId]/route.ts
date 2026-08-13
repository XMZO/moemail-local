import { createDb } from "@/lib/db"
import { messageShares, messages, emails } from "@/lib/schema"
import { eq, and } from "drizzle-orm"
import { NextResponse } from "next/server"
import { authorizeRequest } from "@/lib/request-auth"
import { PERMISSIONS } from "@/lib/permissions"
import { apiError } from "@/lib/api-response"

export const runtime = "nodejs"

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; messageId: string; shareId: string }> }
) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.SHARE_EMAIL,
  })
  if (!authorization.ok) return authorization.response

  const { userId } = authorization.principal

  const { id: emailId, messageId, shareId } = await params
  const db = createDb()

  try {
    const email = await db.query.emails.findFirst({
      where: and(eq(emails.id, emailId), eq(emails.userId, userId))
    })

    if (!email) {
      return apiError("MAILBOX_FORBIDDEN", 403)
    }

    const message = await db.query.messages.findFirst({
      where: and(eq(messages.id, messageId), eq(messages.emailId, emailId))
    })

    if (!message) {
      return apiError("MESSAGE_NOT_FOUND", 404)
    }

    await db.delete(messageShares).where(
      and(eq(messageShares.id, shareId), eq(messageShares.messageId, messageId))
    )

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("message_share.delete_failed", error)
    return apiError("SHARE_DELETE_FAILED", 500)
  }
}

