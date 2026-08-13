import { NextResponse } from "next/server"
import { EXPIRY_OPTIONS } from "@/types/email"
import { PERMISSIONS } from "@/lib/permissions"
import { authorizeRequest } from "@/lib/request-auth"
import { getDomainPolicies } from "@/lib/domain-policies"
import {
  normalizeMailboxDomain,
  normalizeMailboxCreationName,
} from "@/lib/email-address"
import { isDomainAllowed } from "@/lib/access-policies"
import { apiError } from "@/lib/api-response"
import { createMailbox } from "@/lib/mailbox-creation"

export const runtime = "nodejs"

export async function POST(request: Request) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.CREATE_EMAIL,
  })
  if (!authorization.ok) return authorization.response

  const { userId, access } = authorization.principal

  try {
    const maxEmails = access.quotas.maxActiveMailboxes

    const payload = await request.json().catch(() => null) as {
      name?: unknown
      expiryTime?: unknown
      domain?: unknown
    } | null
    if (!payload) {
      return apiError("INVALID_JSON", 400)
    }
    const { name, expiryTime, domain } = payload

    if (
      typeof expiryTime !== "number"
      || !EXPIRY_OPTIONS.some(option => option.value === expiryTime)
    ) {
      return apiError("INVALID_EXPIRY", 400)
    }

    const customName = typeof name === "string" && name.trim().length > 0
      ? normalizeMailboxCreationName(name)
      : null
    if (typeof name === "string" && name.trim().length > 0 && !customName) {
      return apiError("INVALID_MAILBOX_NAME", 400)
    }

    const maximumLifetimeDays = access.quotas.maxMailboxLifetimeDays
    if (
      maximumLifetimeDays > 0
      && (expiryTime === 0 || expiryTime > maximumLifetimeDays * 86_400_000)
    ) {
      return apiError("MAILBOX_LIFETIME_EXCEEDED", 403, { details: { maximumLifetimeDays } })
    }

    const requestedDomain = normalizeMailboxDomain(domain)
    const domains = (await getDomainPolicies()).map(policy => policy.domain)

    if (!requestedDomain || !domains.includes(requestedDomain)) {
      return apiError("INVALID_MAIL_DOMAIN", 400)
    }
    if (!isDomainAllowed(access, requestedDomain)) {
      return apiError("MAIL_DOMAIN_FORBIDDEN", 403)
    }

    const now = new Date()
    const expires = expiryTime === 0 
      ? new Date('9999-01-01T00:00:00.000Z')
      : new Date(now.getTime() + expiryTime)
    
    const result = await createMailbox({
      userId,
      localPart: customName,
      domain: requestedDomain,
      expiresAt: expires,
      maxActiveMailboxes: maxEmails,
    })
    if (result.ok) return NextResponse.json({ id: result.id, email: result.address })
    if (result.code === "MAILBOX_QUOTA_EXCEEDED") {
      return apiError(result.code, 403, { details: { limit: maxEmails } })
    }
    if (result.code === "MAILBOX_NAME_BLOCKED") return apiError(result.code, 403)
    if (result.code === "MAILBOX_ADDRESS_CONFLICT") return apiError(result.code, 409)
    return apiError(result.code, 503)
  } catch (error) {
    console.error("mailbox.create_failed", error)
    return apiError("MAILBOX_CREATE_FAILED", 500)
  }
}
