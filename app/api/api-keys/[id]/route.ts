import { createDb } from "@/lib/db"
import { apiKeys } from "@/lib/schema"
import { NextResponse } from "next/server"
import { PERMISSIONS } from "@/lib/permissions"
import { eq, and } from "drizzle-orm"
import { authorizeRequest } from "@/lib/request-auth"

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
      return NextResponse.json(
        { error: "API Key 不存在或无权删除" },
        { status: 404 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Failed to delete API key:", error)
    return NextResponse.json(
      { error: "删除 API Key 失败" },
      { status: 500 }
    )
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
      return NextResponse.json(
        { error: "API Key 不存在或无权更新" },
        { status: 404 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Failed to update API key:", error)
    return NextResponse.json(
      { error: "更新 API Key 失败" },
      { status: 500 }
    )
  }
}
