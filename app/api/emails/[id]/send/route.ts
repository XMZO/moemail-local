import { NextResponse } from "next/server"
import { createDb } from "@/lib/db"
import { messages } from "@/lib/schema"
import {
  completeSendQuotaReservations,
  releaseSendQuotaReservations,
  reserveSendQuota,
} from "@/lib/send-permissions"
import { authorizeRequest } from "@/lib/request-auth"
import { PERMISSIONS } from "@/lib/permissions"
import { outboundContent, outboundMessageSchema, resolveOutboundPolicy, sendOutboundMessage } from "@/lib/outbound-mail"
import { isDomainOperationAllowed } from "@/lib/access-policies"
import { normalizeMailboxDomain } from "@/lib/email-address"
import { getUserAccessPolicy } from "@/lib/user-access"
import { apiError } from "@/lib/api-response"
import { findOwnedActiveMailbox, ownedMailboxState } from "@/lib/mailbox-access"

export const runtime = "nodejs"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authorization = await authorizeRequest(request, {
      permission: PERMISSIONS.SEND_EMAIL,
    })
    if (!authorization.ok) return authorization.response

    const { userId, access } = authorization.principal

    const { id } = await params
    const db = createDb()

    const payload = await request.json().catch(() => null)
    const parsedMessage = outboundMessageSchema.safeParse(payload)
    if (!parsedMessage.success) {
      return apiError("OUTBOUND_MESSAGE_INVALID", 400)
    }
    const email = await findOwnedActiveMailbox(userId, id)

    if (!email) {
      const state = await ownedMailboxState(userId, id)
      if (state === "expired") return apiError("MAILBOX_EXPIRED", 410)
      return apiError(state === "forbidden" ? "MAILBOX_FORBIDDEN" : "MAILBOX_NOT_FOUND", state === "forbidden" ? 403 : 404)
    }

    const domainPolicy = await resolveOutboundPolicy(email.address)
    if (!domainPolicy || domainPolicy.outbound.mode === "disabled") {
      return apiError("OUTBOUND_DISABLED", 409)
    }

    const separator = email.address.lastIndexOf("@")
    const domain = separator > 0 ? normalizeMailboxDomain(email.address.slice(separator + 1)) : null
    if (!isDomainOperationAllowed(access, domain, "send")) {
      return apiError("MAIL_DOMAIN_SEND_FORBIDDEN", 403)
    }

    const currentAccess = await getUserAccessPolicy(userId)
    if (
      parsedMessage.data.privateRecipients
      && !currentAccess.permissions[PERMISSIONS.PRIVATE_RECIPIENT_DELIVERY]
    ) {
      return apiError("PRIVATE_RECIPIENT_DELIVERY_FORBIDDEN", 403)
    }
    if (!isDomainOperationAllowed(currentAccess, domain, "send")) {
      return apiError("MAIL_DOMAIN_SEND_FORBIDDEN", 403)
    }
    if (!domain) return apiError("INVALID_MAIL_DOMAIN", 400)
    const permissionResult = await reserveSendQuota(
      userId,
      email.address,
      currentAccess,
      parsedMessage.data.to.length,
    )
    if (!permissionResult.canSend || !permissionResult.reservations?.length) {
      const code = permissionResult.error ?? "SEND_PERMISSION_DENIED"
      return apiError(code, code.endsWith("QUOTA_EXCEEDED") ? 429 : 403)
    }

    // Charge before crossing the external transport boundary. If the process
    // disappears with an unknown provider outcome, the attempt stays charged
    // and cannot turn into a repeatable quota bypass after a lease timeout.
    try {
      await completeSendQuotaReservations(permissionResult.reservations)
    } catch (error) {
      await releaseSendQuotaReservations(permissionResult.reservations).catch(() => undefined)
      throw error
    }

    let outboundMessage: Awaited<ReturnType<typeof sendOutboundMessage>>
    try {
      outboundMessage = await sendOutboundMessage(
        email.address,
        parsedMessage.data,
        domainPolicy,
      )
    } catch (error) {
      // A timeout or broken response cannot prove that the provider did not
      // accept the message. Keep the completed charge fail-closed; the emperor
      // can explicitly reset usage after investigating a transport incident.
      throw error
    }

    const { message } = outboundMessage
    const persistence = await Promise.allSettled([
      db.insert(messages).values({
        emailId: email.id,
        fromAddress: email.address,
        toAddress: message.to.join(", "),
        subject: message.subject,
        content: message.format === "text" ? message.content : "",
        type: "sent",
        html: outboundContent(message).html,
      }),
    ])
    if (persistence.some(result => result.status === "rejected")) {
      console.error("outbound.post_send_persistence_failed", {
        historyStored: false,
      })
    }
    return NextResponse.json({
      success: true,
      code: "OUTBOUND_MESSAGE_SENT",
      remainingEmails: permissionResult.remainingEmails,
      transport: domainPolicy.outbound.mode,
      privateRecipients: message.privateRecipients,
      historyStored: persistence[0].status === "fulfilled",
    })
  } catch (error) {
    console.error("outbound.send.failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      code: typeof error === "object" && error !== null && "code" in error
        ? String(error.code).slice(0, 100)
        : "unknown",
    })
    return apiError("OUTBOUND_SEND_FAILED", 502)
  }
}
