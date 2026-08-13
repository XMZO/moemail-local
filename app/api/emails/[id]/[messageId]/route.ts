import { NextResponse } from "next/server"
import { createDb } from "@/lib/db"
import { messages } from "@/lib/schema"
import { and, eq } from "drizzle-orm"
import { authorizeRequest } from "@/lib/request-auth"
import { PERMISSIONS } from "@/lib/permissions"
import { apiError } from "@/lib/api-response"
import { findOwnedActiveMailbox, ownedMailboxState } from "@/lib/mailbox-access"
export const runtime = "nodejs"

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string; messageId: string }> }
) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.DELETE_EMAIL,
  })
  if (!authorization.ok) return authorization.response

  const { userId } = authorization.principal

  try {
    const db = createDb()
    const { id, messageId } = await params
    const email = await findOwnedActiveMailbox(userId, id)
    if (!email) {
      const state = await ownedMailboxState(userId, id)
      if (state === "expired") return apiError("MAILBOX_EXPIRED", 410)
      return apiError(
        state === "not_found" ? "MAILBOX_NOT_FOUND" : "MAILBOX_FORBIDDEN",
        state === "not_found" ? 404 : 403,
      )
    }

    const message = await db.query.messages.findFirst({
      where: and(
          eq(messages.emailId, id),
          eq(messages.id, messageId)
      )
    })

    if(!message) {
      return apiError("MESSAGE_NOT_FOUND", 404)
    }

    await db.delete(messages).where(and(
      eq(messages.id, messageId),
      eq(messages.emailId, id),
    ))

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("message.delete_failed", error)
    return apiError("MESSAGE_DELETE_FAILED", 500)
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string; messageId: string }> }) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.VIEW_EMAIL,
  })
  if (!authorization.ok) return authorization.response

  const { userId } = authorization.principal

  try {
    const { id, messageId } = await params
    const db = createDb()

    const email = await findOwnedActiveMailbox(userId, id)
    if (!email) {
      const state = await ownedMailboxState(userId, id)
      if (state === "expired") return apiError("MAILBOX_EXPIRED", 410)
      return apiError(state === "not_found" ? "MAILBOX_NOT_FOUND" : "MAILBOX_FORBIDDEN", state === "not_found" ? 404 : 403)
    }

    const message = await db.query.messages.findFirst({
      where: and(
        eq(messages.id, messageId),
        eq(messages.emailId, id)
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
        received_at: message.receivedAt.getTime(),
        sent_at: message.sentAt?.getTime() ?? null,
        type: message.type as 'received' | 'sent'
      }
    })
  } catch (error) {
    console.error("message.read_failed", error)
    return apiError("MESSAGE_READ_FAILED", 500)
  }
}
