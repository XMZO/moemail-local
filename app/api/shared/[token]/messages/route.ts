import { createDb } from "@/lib/db"
import { emailShares, messages } from "@/lib/schema"
import { eq, and, lt, or, sql, ne, isNull } from "drizzle-orm"
import { NextResponse } from "next/server"
import { encodeCursor, decodeCursor } from "@/lib/cursor"
import { setupRequiredResponse } from "@/lib/request-auth"

export const runtime = "nodejs"

const PAGE_SIZE = 20

// 通过分享token获取邮箱的消息列表
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
    // 验证分享token
    const share = await db.query.emailShares.findFirst({
      where: eq(emailShares.token, token),
      with: {
        email: true
      }
    })

    if (!share) {
      return NextResponse.json(
        { error: "Share link not found or expired" },
        { status: 404 }
      )
    }

    // 检查分享是否过期
    if (share.expiresAt && share.expiresAt < new Date()) {
      return NextResponse.json(
        { error: "Share link has expired" },
        { status: 410 }
      )
    }

    // 检查邮箱是否过期
    if (share.email.expiresAt < new Date()) {
      return NextResponse.json(
        { error: "Email has expired" },
        { status: 410 }
      )
    }

    const emailId = share.email.id

    // 只显示接收的邮件，不显示发送的邮件
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
    console.error("Failed to fetch shared messages:", error)
    return NextResponse.json(
      { error: "Failed to fetch messages" },
      { status: 500 }
    )
  }
}

