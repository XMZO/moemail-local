import { createHash } from "node:crypto"
import { and, eq, gt, sql } from "drizzle-orm"
import PostalMime from "postal-mime"
import { WEBHOOK_CONFIG } from "../config"
import { createDb, getDatabaseDriver, getPostgresPool, getSqlite } from "./db"
import { getDomainPolicy } from "./domain-policies"
import { normalizeMailboxAddress, normalizeMailboxDomain } from "./email-address"
import { PERMISSIONS } from "./permissions"
import { emails, messages, webhooks } from "./schema"
import { getUserAccessPolicy } from "./user-access"
import { isDomainOperationAllowed } from "./access-policies"
import {
  releaseMailQuotaReservation,
  reserveMailQuota,
  type MailQuotaReservation,
  type MailQuotaError,
} from "./send-permissions"
import type { ApiErrorCode } from "./api-codes"
import { callWebhook, type EmailMessage } from "./webhook"

export const MAX_RAW_EMAIL_SIZE = 25 * 1024 * 1024
export type InboundTransport = "worker" | "imap" | "mailu"

export const INBOUND_INGESTION_ERROR = {
  INVALID_ENVELOPE_RECIPIENT: "INVALID_ENVELOPE_RECIPIENT",
  INVALID_EMAIL_MESSAGE: "INVALID_EMAIL_MESSAGE",
} as const

export type InboundIngestionErrorCode = typeof INBOUND_INGESTION_ERROR[keyof typeof INBOUND_INGESTION_ERROR]

export class InboundIngestionError extends Error {
  constructor(readonly code: InboundIngestionErrorCode) {
    super(code)
    this.name = "InboundIngestionError"
  }
}

export type IngestionResult =
  | { status: "created"; messageId: string }
  | { status: "duplicate"; messageId: string }
  | { status: "ignored"; reason: "unknown_recipient" | "owner_missing" }
  | {
      status: "rejected"
      reason: "transport_disabled" | "permission_denied" | "quota_exceeded" | "message_too_large"
      code: ApiErrorCode
    }

export type InboundRecipientInspection =
  | {
      accepted: true
      normalizedAddress: string
      targetEmail: typeof emails.$inferSelect
      userId: string
    }
  | {
      accepted: false
      reason:
        | "invalid_recipient"
        | "transport_disabled"
        | "unknown_recipient"
        | "owner_missing"
        | "permission_denied"
        | "domain_forbidden"
    }

function recipientDomain(address: string) {
  const separator = address.lastIndexOf("@")
  return separator > 0 ? normalizeMailboxDomain(address.slice(separator + 1)) : null
}

function messageDigest(raw: Buffer, envelopeFrom: string, envelopeTo: string) {
  return createHash("sha256")
    .update("v1\0")
    .update(envelopeTo)
    .update("\0")
    .update(envelopeFrom.toLowerCase())
    .update("\0")
    .update(raw)
    .digest("hex")
}

interface InboundMessageInsert {
  id: string
  emailId: string
  fromAddress: string
  toAddress: string
  subject: string
  content: string
  html: string
}

/**
 * Commits the received message and its quota event as one database unit. A
 * process exit can therefore leave neither record or both records, never a
 * stored message whose rolling/lifetime usage later disappears.
 */
async function commitInboundMessage(
  reservation: MailQuotaReservation,
  message: InboundMessageInsert,
): Promise<"created" | "duplicate" | "inactive"> {
  if (getDatabaseDriver() === "sqlite") {
    return getSqlite().transaction(() => {
      const now = new Date()
      const activeMailbox = getSqlite().prepare(`
        SELECT id FROM email
        WHERE id = ? AND "userId" = ? AND LOWER(address) = ? AND expires_at > ?
      `).get(message.emailId, reservation.userId, reservation.mailboxAddress, now.getTime())
      if (!activeMailbox) {
        getSqlite().prepare(`
          DELETE FROM send_quota_event WHERE id = ? AND status = 'reserved' AND direction = 'receive'
        `).run(reservation.id)
        return "inactive"
      }
      const inserted = getSqlite().prepare(`
        INSERT OR IGNORE INTO message
          (id, emailId, from_address, to_address, subject, content, html, type, received_at, sent_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)
      `).run(
        message.id,
        message.emailId,
        message.fromAddress,
        message.toAddress,
        message.subject,
        message.content,
        message.html,
        now.getTime(),
        now.getTime(),
      )
      if (inserted.changes !== 1) {
        getSqlite().prepare(`
          DELETE FROM send_quota_event WHERE id = ? AND status = 'reserved' AND direction = 'receive'
        `).run(reservation.id)
        return "duplicate"
      }
      const completed = getSqlite().prepare(`
        UPDATE send_quota_event SET status = 'sent', completed_at = ?
        WHERE id = ? AND status = 'reserved' AND direction = 'receive'
      `).run(now.getTime(), reservation.id)
      if (completed.changes !== 1) throw new Error("MAIL_QUOTA_RESERVATION_NOT_FOUND")
      return "created"
    }).immediate()
  }

  const client = await getPostgresPool().connect()
  try {
    await client.query("BEGIN")
    const now = new Date()
    const activeMailbox = await client.query(`
      SELECT id FROM email
      WHERE id = $1 AND "userId" = $2 AND LOWER(address) = $3 AND expires_at > $4
      FOR UPDATE
    `, [message.emailId, reservation.userId, reservation.mailboxAddress, now])
    if (activeMailbox.rowCount !== 1) {
      await client.query(`
        DELETE FROM send_quota_event
        WHERE id = $1 AND status = 'reserved' AND direction = 'receive'
      `, [reservation.id])
      await client.query("COMMIT")
      return "inactive"
    }
    const inserted = await client.query(`
      INSERT INTO message
        (id, "emailId", from_address, to_address, subject, content, html, type, received_at, sent_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'received', $8, $8)
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `, [
      message.id,
      message.emailId,
      message.fromAddress,
      message.toAddress,
      message.subject,
      message.content,
      message.html,
      now,
    ])
    if (inserted.rowCount !== 1) {
      await client.query(`
        DELETE FROM send_quota_event
        WHERE id = $1 AND status = 'reserved' AND direction = 'receive'
      `, [reservation.id])
      await client.query("COMMIT")
      return "duplicate"
    }
    const completed = await client.query(`
      UPDATE send_quota_event SET status = 'sent', completed_at = $1
      WHERE id = $2 AND status = 'reserved' AND direction = 'receive'
    `, [now, reservation.id])
    if (completed.rowCount !== 1) throw new Error("MAIL_QUOTA_RESERVATION_NOT_FOUND")
    await client.query("COMMIT")
    return "created"
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export async function inspectInboundRecipient(
  value: string,
  transport: InboundTransport,
): Promise<InboundRecipientInspection> {
  const normalizedAddress = normalizeMailboxAddress(value)
  if (!normalizedAddress) return { accepted: false, reason: "invalid_recipient" }
  const domain = recipientDomain(normalizedAddress)
  const domainPolicy = domain ? await getDomainPolicy(domain) : null
  if (!domainPolicy || domainPolicy.inbound.mode !== transport) {
    return { accepted: false, reason: "transport_disabled" }
  }

  const targetEmail = await createDb().query.emails.findFirst({
    where: and(
      eq(sql`LOWER(${emails.address})`, normalizedAddress),
      gt(emails.expiresAt, new Date()),
    ),
  })
  if (!targetEmail) return { accepted: false, reason: "unknown_recipient" }
  if (!targetEmail.userId) return { accepted: false, reason: "owner_missing" }

  const access = await getUserAccessPolicy(targetEmail.userId)
  if (!access.permissions[PERMISSIONS.RECEIVE_EMAIL]) {
    return { accepted: false, reason: "permission_denied" }
  }
  if (!isDomainOperationAllowed(access, domain, "receive")) {
    return { accepted: false, reason: "domain_forbidden" }
  }
  return {
    accepted: true,
    normalizedAddress,
    targetEmail,
    userId: targetEmail.userId,
  }
}

async function deliverWebhook(
  targetEmail: typeof emails.$inferSelect,
  savedMessage: typeof messages.$inferSelect,
  envelopeFrom: string,
) {
  if (!targetEmail.userId) return
  try {
    const db = createDb()
    const webhook = await db.query.webhooks.findFirst({
      where: eq(webhooks.userId, targetEmail.userId),
    })
    if (!webhook?.enabled) return

    const webhookMessage: EmailMessage = {
      emailId: targetEmail.id,
      messageId: savedMessage.id,
      fromAddress: savedMessage.fromAddress ?? envelopeFrom,
      subject: savedMessage.subject,
      content: savedMessage.content,
      html: savedMessage.html ?? "",
      receivedAt: savedMessage.receivedAt.toISOString(),
      toAddress: targetEmail.address,
    }
    await callWebhook(webhook.url, {
      event: WEBHOOK_CONFIG.EVENTS.NEW_MESSAGE,
      data: webhookMessage,
    })
  } catch (error) {
    console.error("ingest.webhook.failed", {
      messageId: savedMessage.id,
      error: error instanceof Error ? error.message.slice(0, 500) : "unknown",
    })
  }
}

export async function ingestEmail(input: {
  raw: Buffer
  envelopeFrom: string
  envelopeTo: string
  transport: InboundTransport
}): Promise<IngestionResult> {
  const inspected = await inspectInboundRecipient(input.envelopeTo, input.transport)
  if (!inspected.accepted) {
    if (inspected.reason === "invalid_recipient") {
      throw new InboundIngestionError(INBOUND_INGESTION_ERROR.INVALID_ENVELOPE_RECIPIENT)
    }
    if (inspected.reason === "unknown_recipient" || inspected.reason === "owner_missing") {
      return {
        status: "ignored",
        reason: inspected.reason === "owner_missing" ? "owner_missing" : "unknown_recipient",
      }
    }
    const permissionDenied = inspected.reason === "permission_denied"
      || inspected.reason === "domain_forbidden"
    return {
      status: "rejected",
      reason: permissionDenied ? "permission_denied" : "transport_disabled",
      code: inspected.reason === "domain_forbidden"
        ? "MAIL_DOMAIN_RECEIVE_FORBIDDEN"
        : inspected.reason === "permission_denied"
          ? "RECEIVE_PERMISSION_DENIED"
          : "EMAIL_INGESTION_UNAVAILABLE",
    }
  }
  const { normalizedAddress: envelopeTo, targetEmail, userId } = inspected
  if (input.raw.byteLength > MAX_RAW_EMAIL_SIZE) {
    return { status: "rejected", reason: "message_too_large", code: "MESSAGE_TOO_LARGE" }
  }
  const db = createDb()

  const messageId = messageDigest(input.raw, input.envelopeFrom, envelopeTo)
  const existing = await db.query.messages.findFirst({
    where: eq(messages.id, messageId),
    columns: { id: true },
  })
  if (existing) return { status: "duplicate", messageId }

  {
    const duplicate = await db.query.messages.findFirst({
      where: eq(messages.id, messageId),
      columns: { id: true },
    })
    if (duplicate) return { status: "duplicate", messageId }

    const access = await getUserAccessPolicy(userId)
    if (!access.permissions[PERMISSIONS.RECEIVE_EMAIL]) {
      return { status: "rejected", reason: "permission_denied", code: "RECEIVE_PERMISSION_DENIED" }
    }
    if (!isDomainOperationAllowed(access, recipientDomain(envelopeTo), "receive")) {
      return { status: "rejected", reason: "permission_denied", code: "MAIL_DOMAIN_RECEIVE_FORBIDDEN" }
    }
    if (
      access.quotas.maxMessageBytes > 0
      && input.raw.byteLength > access.quotas.maxMessageBytes
    ) {
      return { status: "rejected", reason: "message_too_large", code: "MESSAGE_TOO_LARGE" }
    }

    let parsedMessage
    try {
      parsedMessage = await PostalMime.parse(input.raw)
    } catch {
      throw new InboundIngestionError(INBOUND_INGESTION_ERROR.INVALID_EMAIL_MESSAGE)
    }

    const quota = await reserveMailQuota(userId, envelopeTo, "receive", access)
    if (!quota.allowed || !quota.reservation) {
      const code: MailQuotaError = quota.error ?? "RECEIVE_PERMISSION_CHECK_FAILED"
      return {
        status: "rejected",
        reason: code.includes("PERMISSION") || code.includes("FORBIDDEN")
          ? "permission_denied"
          : "quota_exceeded",
        code,
      }
    }

    try {
      const commit = await commitInboundMessage(quota.reservation, {
        id: messageId,
        emailId: targetEmail.id,
        fromAddress: input.envelopeFrom,
        toAddress: envelopeTo,
        subject: parsedMessage.subject || "",
        content: parsedMessage.text || "",
        html: parsedMessage.html || "",
      })
      if (commit === "duplicate") return { status: "duplicate", messageId }
      if (commit === "inactive") return { status: "ignored", reason: "unknown_recipient" }
    } catch (error) {
      await releaseMailQuotaReservation(quota.reservation).catch(() => undefined)
      throw error
    }
    await deliverWebhook(targetEmail, {
      id: messageId,
      emailId: targetEmail.id,
      fromAddress: input.envelopeFrom,
      toAddress: envelopeTo,
      subject: parsedMessage.subject || "",
      content: parsedMessage.text || "",
      html: parsedMessage.html || "",
      type: "received",
      receivedAt: new Date(),
      sentAt: new Date(),
    }, input.envelopeFrom)
    return { status: "created", messageId }
  }
}
