import { NextResponse } from "next/server"
import { nanoid } from "nanoid"
import { createDb } from "@/lib/db"
import { emails } from "@/lib/schema"
import { eq, and, gt, sql } from "drizzle-orm"
import { EXPIRY_OPTIONS } from "@/types/email"
import { PERMISSIONS } from "@/lib/permissions"
import { authorizeRequest } from "@/lib/request-auth"
import { getDomainPolicies } from "@/lib/domain-policies"
import {
  normalizeMailboxDomain,
  normalizeMailboxLocalPart,
} from "@/lib/email-address"

export const runtime = "nodejs"

function isEmailAddressConflict(error: unknown) {
  let current = error
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { cause?: unknown; code?: unknown }
    if (candidate.code === "SQLITE_CONSTRAINT_UNIQUE" || candidate.code === "23505") {
      return true
    }
    current = candidate.cause
  }
  return false
}

export async function POST(request: Request) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.CREATE_EMAIL,
  })
  if (!authorization.ok) return authorization.response

  const { userId, access } = authorization.principal

  try {
    const db = createDb()
    const maxEmails = access.quotas.maxActiveMailboxes
    if (maxEmails > 0) {
      const activeEmailsCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(emails)
        .where(
          and(
            eq(emails.userId, userId),
            gt(emails.expiresAt, new Date())
          )
        )
      
      if (Number(activeEmailsCount[0].count) >= maxEmails) {
        return NextResponse.json(
          { error: `已达到最大邮箱数量限制 (${maxEmails})` },
          { status: 403 }
        )
      }
    }

    const payload = await request.json().catch(() => null) as {
      name?: unknown
      expiryTime?: unknown
      domain?: unknown
    } | null
    if (!payload) {
      return NextResponse.json({ error: "请求格式无效" }, { status: 400 })
    }
    const { name, expiryTime, domain } = payload

    if (
      typeof expiryTime !== "number"
      || !EXPIRY_OPTIONS.some(option => option.value === expiryTime)
    ) {
      return NextResponse.json(
        { error: "无效的过期时间" },
        { status: 400 }
      )
    }

    const normalizedName = typeof name === "string" && name.trim()
      ? normalizeMailboxLocalPart(name)
      : normalizeMailboxLocalPart(nanoid(8))
    if (!normalizedName) {
      return NextResponse.json(
        { error: "邮箱名称仅支持 1-64 位 ASCII 字母、数字、点、下划线、加号和连字符" },
        { status: 400 },
      )
    }

    const maximumLifetimeDays = access.quotas.maxMailboxLifetimeDays
    if (
      maximumLifetimeDays > 0
      && (expiryTime === 0 || expiryTime > maximumLifetimeDays * 86_400_000)
    ) {
      return NextResponse.json(
        { error: `邮箱有效期不能超过 ${maximumLifetimeDays} 天` },
        { status: 403 },
      )
    }

    const requestedDomain = normalizeMailboxDomain(domain)
    const domains = (await getDomainPolicies()).map(policy => policy.domain)

    if (!requestedDomain || !domains.includes(requestedDomain)) {
      return NextResponse.json(
        { error: "无效的域名" },
        { status: 400 }
      )
    }

    const address = `${normalizedName}@${requestedDomain}`
    const existingEmail = await db.query.emails.findFirst({
      where: eq(sql`LOWER(${emails.address})`, address.toLowerCase())
    })

    if (existingEmail) {
      return NextResponse.json(
        { error: "该邮箱地址已被使用" },
        { status: 409 }
      )
    }

    const now = new Date()
    const expires = expiryTime === 0 
      ? new Date('9999-01-01T00:00:00.000Z')
      : new Date(now.getTime() + expiryTime)
    
    const emailData: typeof emails.$inferInsert = {
      address,
      createdAt: now,
      expiresAt: expires,
      userId
    }
    
    const result = await db.insert(emails)
      .values(emailData)
      .returning({ id: emails.id, address: emails.address })
    
    return NextResponse.json({ 
      id: result[0].id,
      email: result[0].address 
    })
  } catch (error) {
    if (isEmailAddressConflict(error)) {
      return NextResponse.json(
        { error: "该邮箱地址已被使用" },
        { status: 409 }
      )
    }
    console.error('Failed to generate email:', error)
    return NextResponse.json(
      { error: "创建邮箱失败" },
      { status: 500 }
    )
  }
}
