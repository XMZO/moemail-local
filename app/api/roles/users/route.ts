import { createDb } from "@/lib/db"
import { emails, users, userRoles, roles } from "@/lib/schema"
import { and, eq, exists, isNull, isNotNull, or, sql } from "drizzle-orm"
import { PERMISSIONS, ROLES, type Role } from "@/lib/permissions"
import { authorizeRequest } from "@/lib/request-auth"
import { getAccessPolicies } from "@/lib/access-policies"
import { apiError } from "@/lib/api-response"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const MAX_USER_LIST_PAGE = 10_000
const privateHeaders = { "Cache-Control": "private, no-store" }

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.PROMOTE_USER,
  })
  if (!authorization.ok) return authorization.response

  const { searchParams } = new URL(request.url)
  const pageValue = Number(searchParams.get("page") || "1")
  const pageSizeValue = Number(searchParams.get("pageSize") || "20")
  const page = Number.isSafeInteger(pageValue) && pageValue >= 1
    ? Math.min(MAX_USER_LIST_PAGE, pageValue)
    : 1
  const pageSize = Number.isSafeInteger(pageSizeValue)
    ? Math.min(100, Math.max(1, pageSizeValue))
    : 20
  const search = searchParams.get("search")?.trim().slice(0, 200)
  const roleFilter = searchParams.get("role")
  const statusFilter = searchParams.get("status")
  const mailboxFilter = searchParams.get("mailboxes")

  const db = createDb()

  try {
    const searchCondition = search
      ? or(
          sql`LOWER(COALESCE(${users.username}, '')) LIKE ${`%${search.toLowerCase()}%`}`,
          sql`LOWER(COALESCE(${users.email}, '')) LIKE ${`%${search.toLowerCase()}%`}`,
          sql`LOWER(COALESCE(${users.name}, '')) LIKE ${`%${search.toLowerCase()}%`}`
        )
      : undefined

    const conditions = [searchCondition].filter((value): value is NonNullable<typeof value> => Boolean(value))
    if (statusFilter === "active") conditions.push(isNull(users.bannedAt))
    if (statusFilter === "banned") conditions.push(isNotNull(users.bannedAt))
    if (mailboxFilter === "with") {
      conditions.push(exists(
        db.select({ id: emails.id }).from(emails).where(eq(emails.userId, users.id)),
      ))
    } else if (mailboxFilter === "without") {
      conditions.push(sql`NOT EXISTS (
        SELECT 1 FROM ${emails} WHERE ${emails.userId} = ${users.id}
      )`)
    }
    if (roleFilter && roleFilter !== "all" && Object.values(ROLES).includes(roleFilter as Role)) {
      conditions.push(exists(
        db.select({ id: userRoles.userId })
          .from(userRoles)
          .innerJoin(roles, eq(roles.id, userRoles.roleId))
          .where(and(eq(userRoles.userId, users.id), eq(roles.name, roleFilter))),
      ))
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined

    const totalResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(users)
      .where(where)
    const total = Number(totalResult[0].count)

    const roleRank = sql`CASE COALESCE(${roles.name}, ${ROLES.CIVILIAN})
      WHEN ${ROLES.EMPEROR} THEN 0
      WHEN ${ROLES.DUKE} THEN 1
      WHEN ${ROLES.KNIGHT} THEN 2
      WHEN ${ROLES.CIVILIAN} THEN 3
      ELSE 4
    END`

    const userList = await db
      .select({
        id: users.id,
        name: users.name,
        username: users.username,
        email: users.email,
        image: users.image,
        bannedAt: users.bannedAt,
        role: roles.name,
        mailboxCount: sql<number>`(
          SELECT COUNT(*) FROM ${emails}
          WHERE ${emails.userId} = ${users.id}
        )`,
      })
      .from(users)
      .leftJoin(userRoles, eq(userRoles.userId, users.id))
      .leftJoin(roles, eq(roles.id, userRoles.roleId))
      .where(where)
      .orderBy(roleRank, sql`LENGTH(COALESCE(${users.username}, ${users.name}))`, sql`LOWER(COALESCE(${users.username}, ${users.name}))`)
      .limit(pageSize)
      .offset((page - 1) * pageSize)

    const accessPolicies = await getAccessPolicies()
    return Response.json({
      users: userList.map((u) => ({
        id: u.id,
        name: u.name,
        username: u.username,
        email: u.email,
        image: u.image,
        bannedAt: u.bannedAt,
        role: u.role || null,
        mailboxCount: Number(u.mailboxCount ?? 0),
        accessOverride: accessPolicies.users[u.id] ?? null,
      })),
      total,
      page,
      pageSize,
    }, { headers: privateHeaders })
  } catch (error) {
    console.error("user.list_failed", error)
    return apiError("USERS_READ_FAILED", 500)
  }
}

export async function POST(request: Request) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.PROMOTE_USER,
  })
  if (!authorization.ok) return authorization.response

  try {
    const json = await request.json()
    const { searchText } = json as { searchText: string }

    if (!searchText) {
      return apiError("USER_SEARCH_REQUIRED", 400)
    }

    const db = createDb()

    const user = await db.query.users.findFirst({
      where: searchText.includes('@') ? eq(users.email, searchText) : eq(users.username, searchText),
      with: {
        userRoles: {
          with: {
            role: true
          }
        }
      }
    });

    if (!user) {
      return apiError("USER_NOT_FOUND", 404)
    }

    return Response.json({
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        email: user.email,
        role: user.userRoles[0]?.role.name,
        bannedAt: user.bannedAt,
      }
    }, { headers: privateHeaders })
  } catch (error) {
    console.error("user.search_failed", error)
    return apiError("USER_SEARCH_FAILED", 500)
  }
}
