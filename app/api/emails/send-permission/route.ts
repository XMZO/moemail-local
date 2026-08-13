import { NextResponse } from "next/server"
import { checkSendPermission } from "@/lib/send-permissions"
import { authorizeRequest } from "@/lib/request-auth"
import { PERMISSIONS } from "@/lib/permissions"
import { resolveOutboundPolicy } from "@/lib/outbound-mail"
import { isDomainOperationAllowed } from "@/lib/access-policies"
import { normalizeMailboxDomain } from "@/lib/email-address"
import { apiErrorBody } from "@/lib/api-response"
import { findOwnedActiveMailbox, ownedMailboxState } from "@/lib/mailbox-access"

export const runtime = "nodejs"

export async function GET(request: Request) {
  try {
    const authorization = await authorizeRequest(request, {
      permission: PERMISSIONS.SEND_EMAIL,
    })
    if (!authorization.ok) return authorization.response

    const { userId, access } = authorization.principal
    const emailId = new URL(request.url).searchParams.get("emailId")
    let senderDomain: string | null = null
    let senderAddress: string | null = null
    if (emailId) {
      const email = await findOwnedActiveMailbox(userId, emailId)
      if (!email) {
        const state = await ownedMailboxState(userId, emailId)
        const code = state === "expired" ? "MAILBOX_EXPIRED" : state === "forbidden" ? "MAILBOX_FORBIDDEN" : "MAILBOX_NOT_FOUND"
        const status = state === "expired" ? 410 : state === "forbidden" ? 403 : 404
        return NextResponse.json({ canSend: false, ...apiErrorBody(code) }, { status })
      }
      senderAddress = email.address
      const separator = email.address.lastIndexOf("@")
      senderDomain = separator > 0 ? normalizeMailboxDomain(email.address.slice(separator + 1)) : null
      if (!isDomainOperationAllowed(access, senderDomain, "send")) {
        return NextResponse.json({ canSend: false, ...apiErrorBody("MAIL_DOMAIN_SEND_FORBIDDEN") })
      }
      const policy = await resolveOutboundPolicy(email.address)
      if (!policy || policy.outbound.mode === "disabled") {
        return NextResponse.json({ canSend: false, ...apiErrorBody("OUTBOUND_DISABLED") })
      }
    }

    if (!senderAddress) {
      return NextResponse.json({ canSend: false, ...apiErrorBody("MAILBOX_NOT_FOUND") }, { status: 400 })
    }
    const result = await checkSendPermission(userId, senderAddress, access)
    
    return NextResponse.json(result)
  } catch (error) {
    console.error("outbound.permission_check_failed", error)
    return NextResponse.json({
      canSend: false,
      ...apiErrorBody("SEND_PERMISSION_CHECK_FAILED"),
    }, { status: 500 })
  }
}
