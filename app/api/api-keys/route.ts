import { createDb } from "@/lib/db"
import { apiKeys } from "@/lib/schema"
import { nanoid } from "nanoid"
import { NextResponse } from "next/server"
import { PERMISSIONS } from "@/lib/permissions"
import { desc, eq } from "drizzle-orm"
import { authorizeRequest } from "@/lib/request-auth"
import { apiError } from "@/lib/api-response"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.MANAGE_API_KEY,
  })
  if (!authorization.ok) return authorization.response

  try {
    const db = createDb()
    const keys = await db.query.apiKeys.findMany({
      where: eq(apiKeys.userId, authorization.principal.userId),
      orderBy: desc(apiKeys.createdAt),
    })

    return NextResponse.json({
      apiKeys: keys.map(key => ({
        ...key,
        key: undefined
      }))
    })
  } catch (error) {
    console.error("api_key.read_failed", error)
    return apiError("API_KEYS_READ_FAILED", 500)
  }
}

export async function POST(request: Request) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.MANAGE_API_KEY,
  })
  if (!authorization.ok) return authorization.response

  try {
    const { name } = await request.json() as { name: string }
    if (!name?.trim()) {
      return apiError("API_KEY_NAME_REQUIRED", 400)
    }

    const key = `mk_${nanoid(32)}`
    const db = createDb()
    
    await db.insert(apiKeys).values({
      name,
      key,
      userId: authorization.principal.userId,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
    })

    return NextResponse.json({ key })
  } catch (error) {
    console.error("api_key.create_failed", error)
    return apiError("API_KEY_CREATE_FAILED", 500)
  }
}
