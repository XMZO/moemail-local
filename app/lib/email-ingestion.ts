import { createHash } from "node:crypto"
import { and, eq, gte, gt, sql } from "drizzle-orm"
import PostalMime from "postal-mime"
import { WEBHOOK_CONFIG } from "../config"
import { createDb } from "./db"
import { getDomainPolicy } from "./domain-policies"
import { normalizeMailboxAddress, normalizeMailboxDomain } from "./email-address"
import { PERMISSIONS } from "./permissions"
import { emails, messages, webhooks } from "./schema"
import { getUserAccessPolicy } from "./user-access"
import { callWebhook, type EmailMessage } from "./webhook"

export const MAX_RAW_EMAIL_SIZE = 25 * 1024 * 1024
export type InboundTransport = "worker" | "imap"

export type IngestionResult =
  | { status: "created"; messageId: string }
  | { status: "duplicate"; messageId: string }
  | { status: "ignored"; reason: "unknown_recipient" | "owner_missing" }
  | { status: "rejected"; reason: "transport_disabled" | "permission_denied" | "quota_exceeded" | "message_too_large" }

export type InboundRecipientInspection =
  | {
      accepted: true
      normalizedAddress: string
      targetEmail: typeof emails.$inferSelect
      userId: string
    }
  | {
      accepted: false
      reason: "invalid_recipient" | "transport_disabled" | "unknown_recipient" | "owner_missing" | "permission_denied"
    }

const receiveTails = new Map<string, Promise<void>>()

async function withUserReceiveLock<T>(userId: string, task: () => Promise<T>): Promise<T> {
  const predecessor = receiveTails.get(userId) ?? Promise.resolve()
  let release = () => {}
  const turn = new Promise<void>(resolve => { release = resolve })
  const tail = predecessor.catch(() => {}).then(() => turn)
  receiveTails.set(userId, tail)
  await predecessor.catch(() => {})
  try {
    return await task()
  } finally {
    release()
    if (receiveTails.get(userId) === tail) receiveTails.delete(userId)
  }
}

function startOfUtcDay() {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
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
    if (inspected.reason === "invalid_recipient") throw new Error("Invalid envelope recipient")
    if (inspected.reason === "unknown_recipient" || inspected.reason === "owner_missing") {
      return {
        status: "ignored",
        reason: inspected.reason === "owner_missing" ? "owner_missing" : "unknown_recipient",
      }
    }
    return {
      status: "rejected",
      reason: inspected.reason === "permission_denied" ? "permission_denied" : "transport_disabled",
    }
  }
  const { normalizedAddress: envelopeTo, targetEmail, userId } = inspected
  if (input.raw.byteLength > MAX_RAW_EMAIL_SIZE) {
    return { status: "rejected", reason: "message_too_large" }
  }
  const db = createDb()

  const messageId = messageDigest(input.raw, input.envelopeFrom, envelopeTo)
  const existing = await db.query.messages.findFirst({
    where: eq(messages.id, messageId),
    columns: { id: true },
  })
  if (existing) return { status: "duplicate", messageId }

  return withUserReceiveLock(userId, async () => {
    const duplicate = await db.query.messages.findFirst({
      where: eq(messages.id, messageId),
      columns: { id: true },
    })
    if (duplicate) return { status: "duplicate", messageId }

    const access = await getUserAccessPolicy(userId)
    if (!access.permissions[PERMISSIONS.RECEIVE_EMAIL]) {
      return { status: "rejected", reason: "permission_denied" }
    }
    if (
      access.quotas.maxMessageBytes > 0
      && input.raw.byteLength > access.quotas.maxMessageBytes
    ) {
      return { status: "rejected", reason: "message_too_large" }
    }

    if (access.quotas.dailyReceiveLimit > 0) {
      const received = await db
        .select({ count: sql<number>`count(*)` })
        .from(messages)
        .innerJoin(emails, eq(messages.emailId, emails.id))
        .where(and(
          eq(emails.userId, userId),
          eq(messages.type, "received"),
          gte(messages.receivedAt, startOfUtcDay()),
        ))
      if (Number(received[0]?.count ?? 0) >= access.quotas.dailyReceiveLimit) {
        return { status: "rejected", reason: "quota_exceeded" }
      }
    }

    let parsedMessage
    try {
      parsedMessage = await PostalMime.parse(input.raw)
    } catch {
      throw new Error("Invalid email message")
    }

    const inserted = await db
      .insert(messages)
      .values({
        id: messageId,
        emailId: targetEmail.id,
        fromAddress: input.envelopeFrom,
        toAddress: envelopeTo,
        subject: parsedMessage.subject || "(无主题)",
        content: parsedMessage.text || "",
        html: parsedMessage.html || "",
        type: "received",
      })
      .onConflictDoNothing({ target: messages.id })
      .returning()
    const savedMessage = inserted[0]
    if (!savedMessage) return { status: "duplicate", messageId }

    await deliverWebhook(targetEmail, savedMessage, input.envelopeFrom)
    return { status: "created", messageId }
  })
}
