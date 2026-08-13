import { createDb } from "@/lib/db"
import { emailShares } from "@/lib/schema"
import { eq } from "drizzle-orm"
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
  { params }: { params: Promise<{ id: string }> }
) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.SHARE_EMAIL,
  })
  if (!authorization.ok) return authorization.response

  const { userId } = authorization.principal

  const { id: emailId } = await params
  const db = createDb()

  try {
    const email = await findOwnedActiveMailbox(userId, emailId)
    if (!email) {
      const state = await ownedMailboxState(userId, emailId)
      if (state === "expired") return apiError("MAILBOX_EXPIRED", 410)
      return apiError(state === "forbidden" ? "MAILBOX_FORBIDDEN" : "MAILBOX_NOT_FOUND", state === "forbidden" ? 403 : 404)
    }

    const shares = await db.query.emailShares.findMany({
      where: eq(emailShares.emailId, emailId),
      orderBy: (emailShares, { desc }) => [desc(emailShares.createdAt)]
    })

    return NextResponse.json({ shares, total: shares.length })
  } catch (error) {
    console.error("mailbox_share.read_failed", error)
    return apiError("SHARES_READ_FAILED", 500)
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.SHARE_EMAIL,
  })
  if (!authorization.ok) return authorization.response

  const { userId } = authorization.principal

  const { id: emailId } = await params
  const db = createDb()

  try {
    const email = await findOwnedActiveMailbox(userId, emailId)
    if (!email) {
      const state = await ownedMailboxState(userId, emailId)
      if (state === "expired") return apiError("MAILBOX_EXPIRED", 410)
      return apiError(state === "forbidden" ? "MAILBOX_FORBIDDEN" : "MAILBOX_NOT_FOUND", state === "forbidden" ? 403 : 404)
    }

    const body = await request.json().catch(() => null) as { expiresIn?: unknown } | null
    const expiresIn = parseShareExpiry(body?.expiresIn)
    if (expiresIn === null) return apiError("INVALID_SHARE_EXPIRY", 400)

    const token = nanoid(16)

    const expiresAt = shareExpiresAt(expiresIn)

    const [share] = await db.insert(emailShares).values({
      emailId,
      token,
      expiresAt
    }).returning()

    return NextResponse.json(share, { status: 201 })
  } catch (error) {
    console.error("mailbox_share.create_failed", error)
    return apiError("SHARE_CREATE_FAILED", 500)
  }
}

