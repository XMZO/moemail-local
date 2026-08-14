import { NextResponse } from "next/server"
import { createDb } from "@/lib/db"
import { emails, messages } from "@/lib/schema"
import { eq, and, lt, or, sql, ne, isNull } from "drizzle-orm"
import { encodeCursor, decodeCursor } from "@/lib/cursor"
import { authorizeRequest } from "@/lib/request-auth"
import { PERMISSIONS } from "@/lib/permissions"
import { apiError } from "@/lib/api-response"
import { findOwnedActiveMailbox, ownedMailboxState } from "@/lib/mailbox-access"

export const runtime = "nodejs"

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.DELETE_EMAIL,
  })
  if (!authorization.ok) return authorization.response

  const { userId } = authorization.principal

  try {
    const db = createDb()
    const { id } = await params
    const email = await db.query.emails.findFirst({
      where: and(
        eq(emails.id, id),
        eq(emails.userId, userId),
      ),
    })
    if (!email) {
      return apiError("MAILBOX_FORBIDDEN", 403)
    }
    await db.delete(emails)
      .where(and(eq(emails.id, id), eq(emails.userId, userId)))

    void import("@/lib/mailu/reconcile")
      .then(({ reconcileCurrentMailuIfEnabled }) => reconcileCurrentMailuIfEnabled())
      .catch(error => console.error("mailu.reconcile_after_mailbox_delete_failed", {
        message: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      }))

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("mailbox.delete_failed", error)
    return apiError("MAILBOX_DELETE_FAILED", 500)
  }
} 

const PAGE_SIZE = 20

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.VIEW_EMAIL,
  })
  if (!authorization.ok) return authorization.response

  const { userId } = authorization.principal
  const { searchParams } = new URL(request.url)
  const cursorStr = searchParams.get('cursor')
  const messageType = searchParams.get('type')
  const includeTotal = searchParams.get('includeTotal') === '1'

  try {
    const db = createDb()
    const { id } = await params

    const email = await findOwnedActiveMailbox(userId, id)
    if (!email) {
      const state = await ownedMailboxState(userId, id)
      if (state === "expired") return apiError("MAILBOX_EXPIRED", 410)
      return apiError(state === "not_found" ? "MAILBOX_NOT_FOUND" : "MAILBOX_FORBIDDEN", state === "not_found" ? 404 : 403)
    }

    const baseConditions = and(
      eq(messages.emailId, id),
      messageType === 'sent' 
        ? eq(messages.type, "sent") 
        : or(
            ne(messages.type, "sent"),
            isNull(messages.type)
          )
    )

    const totalCount = includeTotal
      ? Number((await db.select({ count: sql<number>`count(*)` })
          .from(messages)
          .where(baseConditions))[0].count)
      : undefined

    const conditions = [baseConditions]

    if (cursorStr) {
      const { timestamp, id } = decodeCursor(cursorStr)
      const orderByTime = messageType === 'sent' ? messages.sentAt : messages.receivedAt
      conditions.push(
        or(
          lt(orderByTime, new Date(timestamp)),
          and(
            eq(orderByTime, new Date(timestamp)),
            lt(messages.id, id)
          )
        )
      )
    }

    const orderByTime = messageType === 'sent' ? messages.sentAt : messages.receivedAt
    
    const results = await db.query.messages.findMany({
      where: and(...conditions),
      columns: {
        id: true,
        fromAddress: true,
        toAddress: true,
        subject: true,
        receivedAt: true,
        sentAt: true,
      },
      orderBy: (messages, { desc }) => [
        desc(orderByTime),
        desc(messages.id)
      ],
      limit: PAGE_SIZE + 1
    })
    
    const hasMore = results.length > PAGE_SIZE
    const nextCursor = hasMore 
      ? encodeCursor(
          messageType === 'sent' 
            ? results[PAGE_SIZE - 1].sentAt!.getTime()
            : results[PAGE_SIZE - 1].receivedAt.getTime(),
          results[PAGE_SIZE - 1].id
        )
      : null
    const messageList = hasMore ? results.slice(0, PAGE_SIZE) : results

    return NextResponse.json({ 
      messages: messageList.map(msg => ({
        id: msg.id,
        from_address: msg?.fromAddress,
        to_address: msg?.toAddress,
        subject: msg.subject,
        sent_at: msg.sentAt?.getTime(),
        received_at: msg.receivedAt?.getTime()
      })),
      nextCursor,
      ...(totalCount === undefined ? {} : { total: totalCount })
    })
  } catch (error) {
    console.error("message.list_failed", error)
    return apiError("MESSAGES_READ_FAILED", 500)
  }
}
