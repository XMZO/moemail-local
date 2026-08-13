import { apiError } from "@/lib/api-response"
import { PERMISSIONS } from "@/lib/permissions"
import { authorizeRequest } from "@/lib/request-auth"
import { checkMailPermission } from "@/lib/send-permissions"
import { findOwnedActiveMailbox, ownedMailboxState } from "@/lib/mailbox-access"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authorization = await authorizeRequest(request, { permission: PERMISSIONS.VIEW_EMAIL })
  if (!authorization.ok) return authorization.response
  const { id } = await params
  const { userId, access } = authorization.principal
  try {
    const mailbox = await findOwnedActiveMailbox(userId, id)
    if (!mailbox) {
      const state = await ownedMailboxState(userId, id)
      if (state === "expired") return apiError("MAILBOX_EXPIRED", 410)
      return apiError(state === "not_found" ? "MAILBOX_NOT_FOUND" : "MAILBOX_FORBIDDEN", state === "not_found" ? 404 : 403)
    }
    const [send, receive] = await Promise.all([
      checkMailPermission(userId, mailbox.address, "send", access),
      checkMailPermission(userId, mailbox.address, "receive", access),
    ])
    return Response.json({ send, receive }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    console.error("mailbox.quota_read_failed", { name: error instanceof Error ? error.name : "UnknownError" })
    return apiError("MAIL_QUOTA_USAGE_READ_FAILED", 500)
  }
}
