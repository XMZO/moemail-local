import { createDb } from "@/lib/db"
import { apiKeys } from "@/lib/schema"
import { NextResponse } from "next/server"
import { PERMISSIONS } from "@/lib/permissions"
import { eq, and } from "drizzle-orm"
import { authorizeRequest } from "@/lib/request-auth"
import { apiError } from "@/lib/api-response"

export const runtime = "nodejs"

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.MANAGE_API_KEY,
  })
  if (!authorization.ok) return authorization.response

  try {
    const db = createDb()
    const { id } = await params
    
    const result = await db.delete(apiKeys)
      .where(
        and(
          eq(apiKeys.id, id),
          eq(apiKeys.userId, authorization.principal.userId)
        )
      )
      .returning()

    if (!result.length) {
      return apiError("API_KEY_NOT_FOUND", 404)
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("api_key.delete_failed", error)
    return apiError("API_KEY_DELETE_FAILED", 500)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.MANAGE_API_KEY,
  })
  if (!authorization.ok) return authorization.response

  try {
    const { id } = await params

    const { enabled } = await request.json() as { enabled: boolean }
    const db = createDb()
    
    const result = await db.update(apiKeys)
      .set({ enabled })
      .where(
        and(
          eq(apiKeys.id, id),
          eq(apiKeys.userId, authorization.principal.userId)
        )
      )
      .returning()

    if (!result.length) {
      return apiError("API_KEY_NOT_FOUND", 404)
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("api_key.update_failed", error)
    return apiError("API_KEY_UPDATE_FAILED", 500)
  }
}
