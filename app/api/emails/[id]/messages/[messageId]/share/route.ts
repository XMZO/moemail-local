import { createDb } from "@/lib/db"
import { messageShares, messages } from "@/lib/schema"
import { eq, and } from "drizzle-orm"
import { NextResponse } from "next/server"
import { nanoid } from "nanoid"
import { authorizeRequest } from "@/lib/request-auth"
import { PERMISSIONS } from "@/lib/permissions"
import { apiError } from "@/lib/api-response"
import { parseShareExpiry, shareExpiresAt } from "@/lib/share-expiry"
import { findOwnedActiveMailbox, ownedMailboxState } from "@/lib/mailbox-access"

export const runtime = "nodejs"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> }
) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.SHARE_EMAIL,
  })
  if (!authorization.ok) return authorization.response

  const { userId } = authorization.principal

  const { id: emailId, messageId } = await params
  const db = createDb()

  try {
    const email = await findOwnedActiveMailbox(userId, emailId)
    if (!email) {
      const state = await ownedMailboxState(userId, emailId)
      if (state === "expired") return apiError("MAILBOX_EXPIRED", 410)
      return apiError(state === "not_found" ? "MAILBOX_NOT_FOUND" : "MAILBOX_FORBIDDEN", state === "not_found" ? 404 : 403)
    }

    const message = await db.query.messages.findFirst({
      where: and(eq(messages.id, messageId), eq(messages.emailId, emailId))
    })

    if (!message) {
      return apiError("MESSAGE_NOT_FOUND", 404)
    }

    const shares = await db.query.messageShares.findMany({
      where: eq(messageShares.messageId, messageId),
      orderBy: (messageShares, { desc }) => [desc(messageShares.createdAt)]
    })

    return NextResponse.json({ shares, total: shares.length })
  } catch (error) {
    console.error("message_share.read_failed", error)
    return apiError("SHARES_READ_FAILED", 500)
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> }
) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.SHARE_EMAIL,
  })
  if (!authorization.ok) return authorization.response

  const { userId } = authorization.principal

  const { id: emailId, messageId } = await params
  const db = createDb()

  try {
    const email = await findOwnedActiveMailbox(userId, emailId)
    if (!email) {
      const state = await ownedMailboxState(userId, emailId)
      if (state === "expired") return apiError("MAILBOX_EXPIRED", 410)
      return apiError(state === "not_found" ? "MAILBOX_NOT_FOUND" : "MAILBOX_FORBIDDEN", state === "not_found" ? 404 : 403)
    }

    const message = await db.query.messages.findFirst({
      where: and(eq(messages.id, messageId), eq(messages.emailId, emailId))
    })

    if (!message) {
      return apiError("MESSAGE_NOT_FOUND", 404)
    }

    const body = await request.json().catch(() => null) as { expiresIn?: unknown } | null
    const expiresIn = parseShareExpiry(body?.expiresIn)
    if (expiresIn === null) return apiError("INVALID_SHARE_EXPIRY", 400)

    const token = nanoid(16)

    const expiresAt = shareExpiresAt(expiresIn)

    const [share] = await db.insert(messageShares).values({
      messageId,
      token,
      expiresAt
    }).returning()

    return NextResponse.json(share, { status: 201 })
  } catch (error) {
    console.error("message_share.create_failed", error)
    return apiError("SHARE_CREATE_FAILED", 500)
  }
}

