import { createDb } from "@/lib/db"
import { emailShares, messages } from "@/lib/schema"
import { eq, and, lt, or, sql, ne, isNull } from "drizzle-orm"
import { NextResponse } from "next/server"
import { encodeCursor, decodeCursor } from "@/lib/cursor"
import { setupRequiredResponse } from "@/lib/request-auth"
import { apiError } from "@/lib/api-response"

export const runtime = "nodejs"

const PAGE_SIZE = 20

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const setupRequired = setupRequiredResponse()
  if (setupRequired) return setupRequired

  const { token } = await params
  const db = createDb()
  const { searchParams } = new URL(request.url)
  const cursor = searchParams.get('cursor')
  const includeTotal = searchParams.get('includeTotal') === '1'

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

    const emailId = share.email.id

    const baseConditions = and(
      eq(messages.emailId, emailId),
      or(
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

    if (cursor) {
      const { timestamp, id } = decodeCursor(cursor)
      const cursorCondition = or(
        lt(messages.receivedAt, new Date(timestamp)),
        and(
          eq(messages.receivedAt, new Date(timestamp)),
          lt(messages.id, id)
        )
      )
      if (cursorCondition) {
        conditions.push(cursorCondition)
      }
    }

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
        desc(messages.receivedAt),
        desc(messages.id)
      ],
      limit: PAGE_SIZE + 1
    })

    const hasMore = results.length > PAGE_SIZE
    const nextCursor = hasMore
      ? encodeCursor(
          results[PAGE_SIZE - 1].receivedAt.getTime(),
          results[PAGE_SIZE - 1].id
        )
      : null
    const messageList = hasMore ? results.slice(0, PAGE_SIZE) : results

    return NextResponse.json({
      messages: messageList.map(msg => ({
        id: msg.id,
        from_address: msg.fromAddress,
        to_address: msg.toAddress,
        subject: msg.subject,
        received_at: msg.receivedAt,
        sent_at: msg.sentAt
      })),
      nextCursor,
      ...(totalCount === undefined ? {} : { total: totalCount })
    })
  } catch (error) {
    console.error("shared_mailbox.messages_read_failed", error)
    return apiError("MESSAGES_READ_FAILED", 500)
  }
}

