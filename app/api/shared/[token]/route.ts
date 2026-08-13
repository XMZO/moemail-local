import { createDb } from "@/lib/db"
import { emailShares } from "@/lib/schema"
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

    return NextResponse.json({
      email: {
        id: share.email.id,
        address: share.email.address,
        createdAt: share.email.createdAt,
        expiresAt: share.email.expiresAt
      }
    })
  } catch (error) {
    console.error("shared_mailbox.read_failed", error)
    return apiError("SHARED_MAILBOX_READ_FAILED", 500)
  }
}

