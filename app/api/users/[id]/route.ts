import { and, desc, eq, gt, lt, sql } from "drizzle-orm"
import { accounts, apiKeys, emailShares, emails, mailboxNameBlocks, messages, messageShares, sendQuotaEvents, users, webhooks } from "@/lib/schema"
import { domainAccessMode, getAccessPolicies, resolveAccessPolicy } from "@/lib/access-policies"
import { getDomainPolicies } from "@/lib/domain-policies"
import { normalizeMailboxDomain } from "@/lib/email-address"
import { PERMISSIONS, ROLES, type Role } from "@/lib/permissions"
import { authorizeRequest } from "@/lib/request-auth";
import { apiError } from "@/lib/api-response"
import { createDb } from "@/lib/db"
import { deleteUserAtomically } from "@/lib/user-deletion"
import { setUserBannedAtomically } from "@/lib/user-status"

export const runtime = "nodejs";
export const dynamic = "force-dynamic"

const DETAIL_MAILBOX_PAGE_SIZE = 40
const DETAIL_BLOCK_LIMIT = 200
const privateHeaders = { "Cache-Control": "private, no-store" }
const validRoles = new Set<Role>(Object.values(ROLES))

function boundedPage(value: string | null, fallback: number, maximum: number) {
  const parsed = Number(value ?? "")
  return Number.isSafeInteger(parsed) && parsed >= 1 ? Math.min(maximum, parsed) : fallback
}

function safeWebhookUrl(value: string) {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return "[redacted]"
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.PROMOTE_USER,
  })
  if (!authorization.ok) return authorization.response

  const { id: userId } = await params
  if (!userId) return apiError("USER_ID_REQUIRED", 400)

  const searchParams = new URL(request.url).searchParams
  const mailboxPage = boundedPage(searchParams.get("mailboxPage"), 1, 10_000)
  const mailboxPageSize = boundedPage(searchParams.get("mailboxPageSize"), DETAIL_MAILBOX_PAGE_SIZE, 100)
  const mailboxSearch = searchParams.get("mailboxSearch")?.trim().slice(0, 200) ?? ""
  const mailboxDomainValue = searchParams.get("mailboxDomain")?.trim() ?? ""
  const mailboxDomain = normalizeMailboxDomain(mailboxDomainValue)
  const mailboxStatusValue = searchParams.get("mailboxStatus") ?? "all"
  if (mailboxDomainValue && !mailboxDomain) return apiError("INVALID_MAIL_DOMAIN", 400)
  if (!["all", "active", "expired"].includes(mailboxStatusValue)) {
    return apiError("INVALID_REQUEST", 400)
  }
  const mailboxStatus = mailboxStatusValue as "all" | "active" | "expired"
  const now = new Date()

  try {
    const db = createDb()
    const target = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true,
        name: true,
        username: true,
        email: true,
        image: true,
        emailVerified: true,
        password: true,
        bannedAt: true,
      },
      with: { userRoles: { with: { role: true } } },
    })
    if (!target) return apiError("USER_NOT_FOUND", 404)

    const roleNames = target.userRoles.flatMap(item => (
      validRoles.has(item.role.name as Role) ? [item.role.name as Role] : []
    ))
    const [policies, configuredDomains] = await Promise.all([
      getAccessPolicies(),
      getDomainPolicies(),
    ])
    const access = resolveAccessPolicy(policies, userId, roleNames)
    const visibleDomainAccess = {
      default: access.domainAccess.default,
      domains: Object.fromEntries(configuredDomains.map(({ domain }) => [
        domain,
        domainAccessMode(access.domainAccess, domain),
      ])),
    }
    const mailboxConditions = [eq(emails.userId, userId)]
    if (mailboxSearch) {
      mailboxConditions.push(sql`LOWER(${emails.address}) LIKE ${`%${mailboxSearch.toLowerCase()}%`}`)
    }
    if (mailboxDomain) {
      mailboxConditions.push(sql`LOWER(${emails.address}) LIKE ${`%@${mailboxDomain}`}`)
    }
    if (mailboxStatus === "active") mailboxConditions.push(gt(emails.expiresAt, now))
    if (mailboxStatus === "expired") mailboxConditions.push(lt(emails.expiresAt, now))

    const [
      mailboxTotalRows,
      mailboxRows,
      totalMailboxRows,
      activeMailboxRows,
      expiredMailboxRows,
      messageSummaryRows,
      quotaSummaryRows,
      accountRows,
      apiKeyRows,
      webhookRows,
      emailShareRows,
      messageShareRows,
      blockCountRows,
      blockRows,
    ] = await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(emails).where(and(...mailboxConditions)),
      db.select({
        id: emails.id,
        address: emails.address,
        createdAt: emails.createdAt,
        expiresAt: emails.expiresAt,
        messageCount: sql<number>`(
          SELECT COUNT(*) FROM ${messages}
          WHERE ${messages.emailId} = ${emails.id}
        )`,
        receivedCount: sql<number>`(
          SELECT COUNT(*) FROM ${messages}
          WHERE ${messages.emailId} = ${emails.id} AND COALESCE(${messages.type}, 'received') <> 'sent'
        )`,
        sentCount: sql<number>`(
          SELECT COUNT(*) FROM ${messages}
          WHERE ${messages.emailId} = ${emails.id} AND ${messages.type} = 'sent'
        )`,
      })
        .from(emails)
        .where(and(...mailboxConditions))
        .orderBy(desc(emails.createdAt), desc(emails.id))
        .limit(mailboxPageSize)
        .offset((mailboxPage - 1) * mailboxPageSize),
      db.select({ count: sql<number>`count(*)` }).from(emails).where(eq(emails.userId, userId)),
      db.select({ count: sql<number>`count(*)` }).from(emails).where(and(eq(emails.userId, userId), gt(emails.expiresAt, now))),
      db.select({ count: sql<number>`count(*)` }).from(emails).where(and(eq(emails.userId, userId), lt(emails.expiresAt, now))),
      db.select({
        total: sql<number>`count(*)`,
        received: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${messages.type}, 'received') <> 'sent' THEN 1 ELSE 0 END), 0)`,
        sent: sql<number>`COALESCE(SUM(CASE WHEN ${messages.type} = 'sent' THEN 1 ELSE 0 END), 0)`,
      }).from(messages).innerJoin(emails, eq(messages.emailId, emails.id)).where(eq(emails.userId, userId)),
      db.select({ direction: sendQuotaEvents.direction, count: sql<number>`count(*)` })
        .from(sendQuotaEvents)
        .where(eq(sendQuotaEvents.userId, userId))
        .groupBy(sendQuotaEvents.direction),
      db.select({ provider: accounts.provider }).from(accounts).where(eq(accounts.userId, userId)),
      db.select({ id: apiKeys.id, name: apiKeys.name, createdAt: apiKeys.createdAt, expiresAt: apiKeys.expiresAt, enabled: apiKeys.enabled })
        .from(apiKeys).where(eq(apiKeys.userId, userId)).orderBy(desc(apiKeys.createdAt)),
      db.select({ id: webhooks.id, url: webhooks.url, enabled: webhooks.enabled, createdAt: webhooks.createdAt, updatedAt: webhooks.updatedAt })
        .from(webhooks).where(eq(webhooks.userId, userId)).orderBy(desc(webhooks.updatedAt)),
      db.select({ count: sql<number>`count(*)` }).from(emailShares).innerJoin(emails, eq(emailShares.emailId, emails.id)).where(eq(emails.userId, userId)),
      db.select({ count: sql<number>`count(*)` }).from(messageShares)
        .innerJoin(messages, eq(messageShares.messageId, messages.id))
        .innerJoin(emails, eq(messages.emailId, emails.id))
        .where(eq(emails.userId, userId)),
      db.select({ count: sql<number>`count(*)` }).from(mailboxNameBlocks)
        .where(eq(mailboxNameBlocks.userId, userId)),
      db.select({ id: mailboxNameBlocks.id, localPart: mailboxNameBlocks.localPart, domain: mailboxNameBlocks.domain, createdAt: mailboxNameBlocks.createdAt })
        .from(mailboxNameBlocks)
        .where(eq(mailboxNameBlocks.userId, userId))
        .orderBy(desc(mailboxNameBlocks.createdAt), desc(mailboxNameBlocks.id))
        .limit(DETAIL_BLOCK_LIMIT),
    ])

    const mailboxTotal = Number(mailboxTotalRows[0]?.count ?? 0)
    const messageSummary = messageSummaryRows[0] ?? { total: 0, received: 0, sent: 0 }
    const quotaEvents = Object.fromEntries(quotaSummaryRows.map(row => [row.direction, Number(row.count)]))
    const effectiveRules = access.mailQuotaRules.slice(0, 200)

    return Response.json({
      user: {
        id: target.id,
        name: target.name,
        username: target.username,
        email: target.email,
        image: target.image,
        emailVerified: target.emailVerified,
        passwordConfigured: Boolean(target.password),
        bannedAt: target.bannedAt,
        roles: roleNames,
        providers: [...new Set(accountRows.map(row => row.provider))],
      },
      summary: {
        mailboxes: Number(totalMailboxRows[0]?.count ?? 0),
        activeMailboxes: Number(activeMailboxRows[0]?.count ?? 0),
        expiredMailboxes: Number(expiredMailboxRows[0]?.count ?? 0),
        messages: Number(messageSummary.total ?? 0),
        receivedMessages: Number(messageSummary.received ?? 0),
        sentMessages: Number(messageSummary.sent ?? 0),
        apiKeys: apiKeyRows.length,
        enabledApiKeys: apiKeyRows.filter(row => row.enabled && (!row.expiresAt || row.expiresAt > now)).length,
        webhooks: webhookRows.length,
        enabledWebhooks: webhookRows.filter(row => row.enabled).length,
        emailShares: Number(emailShareRows[0]?.count ?? 0),
        messageShares: Number(messageShareRows[0]?.count ?? 0),
        quotaEvents,
      },
      access: {
        permissions: access.permissions,
        quotas: access.quotas,
        domainAccess: visibleDomainAccess,
        allowedDomains: access.allowedDomains,
        quotaRole: access.quotaRole,
        roles: access.roles,
        override: policies.users[userId] ?? null,
        mailQuotaRules: effectiveRules,
        mailQuotaRuleCount: access.mailQuotaRules.length,
        mailQuotaRulesTruncated: access.mailQuotaRules.length > effectiveRules.length,
      },
      mailboxes: {
        items: mailboxRows.map(row => ({
          ...row,
          messageCount: Number(row.messageCount ?? 0),
          receivedCount: Number(row.receivedCount ?? 0),
          sentCount: Number(row.sentCount ?? 0),
        })),
        total: mailboxTotal,
        page: mailboxPage,
        pageSize: mailboxPageSize,
        pages: Math.max(1, Math.ceil(mailboxTotal / mailboxPageSize)),
      },
      resources: {
        apiKeys: apiKeyRows,
        webhooks: webhookRows.map(row => ({ ...row, url: safeWebhookUrl(row.url) })),
        mailboxNameBlocks: blockRows,
        mailboxNameBlockCount: Number(blockCountRows[0]?.count ?? 0),
        mailboxNameBlocksTruncated: Number(blockCountRows[0]?.count ?? 0) > blockRows.length,
      },
    }, { headers: privateHeaders })
  } catch (error) {
    console.error("user.details_read_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    })
    return apiError("USER_DETAILS_READ_FAILED", 500)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.PROMOTE_USER,
  })
  if (!authorization.ok) return authorization.response

  const { id: userId } = await params
  if (!userId) return apiError("USER_ID_REQUIRED", 400)
  if (userId === authorization.principal.userId) return apiError("CANNOT_BAN_SELF", 400)

  const payload = await request.json().catch(() => null) as {
    banned?: unknown
    expectedBanned?: unknown
  } | null
  if (!payload || typeof payload.banned !== "boolean" || (
    payload.expectedBanned !== undefined && typeof payload.expectedBanned !== "boolean"
  )) return apiError("INVALID_REQUEST", 400)

  try {
    const result = await setUserBannedAtomically(
      userId,
      payload.banned,
      payload.expectedBanned as boolean | undefined,
    )
    if (result === "not_found") return apiError("USER_NOT_FOUND", 404)
    if (result === "emperor_immutable") return apiError("CANNOT_BAN_EMPEROR", 400)
    if (result === "state_conflict") return apiError("USER_STATUS_CONFLICT", 409)
    return Response.json({ success: true, banned: result === "banned" }, { headers: privateHeaders })
  } catch (error) {
    console.error("user.status_update_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    })
    return apiError(payload.banned ? "USER_BAN_FAILED" : "USER_UNBAN_FAILED", 500)
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.PROMOTE_USER,
  });
  if (!authorization.ok) return authorization.response;

  try {
    const { id: userId } = await params;
    if (!userId) {
      return apiError("USER_ID_REQUIRED", 400);
    }

    if (userId === authorization.principal.userId) {
      return apiError("CANNOT_DELETE_SELF", 400);
    }

    const result = await deleteUserAtomically(userId)
    if (result === "emperor_immutable") {
      return apiError("CANNOT_DELETE_EMPEROR", 400);
    }
    if (result === "not_found") {
      return apiError("USER_NOT_FOUND", 404)
    }

    void import("@/lib/mailu/reconcile")
      .then(({ reconcileCurrentMailuIfEnabled }) => reconcileCurrentMailuIfEnabled())
      .catch(error => console.error("mailu.reconcile_after_user_delete_failed", {
        message: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      }))

    return Response.json({ success: true });
  } catch (error) {
    console.error("user.delete_failed", error);
    return apiError("USER_DELETE_FAILED", 500);
  }
}
