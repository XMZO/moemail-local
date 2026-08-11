import { createHash, timingSafeEqual } from "node:crypto"
import { createDb } from "@/lib/db"
import { emails, messages, webhooks } from "@/lib/schema"
import { callWebhook, type EmailMessage } from "@/lib/webhook"
import { WEBHOOK_CONFIG } from "@/config"
import { and, eq, gt, sql } from "drizzle-orm"
import PostalMime from "postal-mime"
import { normalizeMailboxAddress } from "@/lib/email-address"
import { getConfig, isSetupCompleted } from "@/lib/config/runtime"

export const runtime = "nodejs"

const MAX_RAW_EMAIL_SIZE = 25 * 1024 * 1024
const BODY_READ_TIMEOUT = 30_000
const CONTENT_TYPE = "message/rfc822"

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  })
}

function isAuthorized(authorization: string | null, secret: string) {
  const match = authorization?.match(/^Bearer ([^\s]+)$/i)
  const suppliedSecret = match?.[1] ?? ""
  const expectedDigest = createHash("sha256").update(secret).digest()
  const suppliedDigest = createHash("sha256").update(suppliedSecret).digest()

  return Boolean(match) && timingSafeEqual(expectedDigest, suppliedDigest)
}

function getEnvelopeHeader(request: Request, name: string, allowEmpty = false) {
  if (!request.headers.has(name)) return null

  const value = request.headers.get(name)?.trim() ?? ""
  if ((!allowEmpty && !value) || value.length > 512 || /[\r\n]/.test(value)) {
    return null
  }

  return value
}

export async function POST(request: Request) {
  if (!isSetupCompleted()) {
    console.error("Email ingestion rejected: MoeMail 尚未完成初始化")
    return json({ error: "Email ingestion is unavailable" }, 503)
  }

  const ingestSecret = getConfig().email.ingestSecret
  if (!ingestSecret) {
    console.error("email.ingestSecret is not configured")
    return json({ error: "Email ingestion is unavailable" }, 503)
  }

  if (!isAuthorized(request.headers.get("authorization"), ingestSecret)) {
    return json({ error: "Unauthorized" }, 401)
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
  if (contentType !== CONTENT_TYPE) {
    return json({ error: "Unsupported media type" }, 415)
  }

  const envelopeFrom = getEnvelopeHeader(request, "x-moemail-envelope-from", true)
  const envelopeTo = getEnvelopeHeader(request, "x-moemail-envelope-to")
  if (envelopeFrom === null || envelopeTo === null) {
    return json({ error: "Invalid envelope" }, 400)
  }
  const normalizedEnvelopeTo = normalizeMailboxAddress(envelopeTo)
  if (!normalizedEnvelopeTo) {
    return json({ error: "Invalid envelope recipient" }, 400)
  }

  const declaredRawSizeHeader = request.headers.get("x-moemail-raw-size")
  if (!declaredRawSizeHeader || !/^\d+$/.test(declaredRawSizeHeader)) {
    return json({ error: "Invalid raw message size" }, 400)
  }
  const declaredRawSize = Number(declaredRawSizeHeader)
  if (!Number.isSafeInteger(declaredRawSize)) {
    return json({ error: "Invalid raw message size" }, 400)
  }
  if (declaredRawSize > MAX_RAW_EMAIL_SIZE) {
    return json({ error: "Message too large" }, 413)
  }

  const contentLengthHeader = request.headers.get("content-length")
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader)
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      return json({ error: "Invalid content length" }, 400)
    }
    if (contentLength > MAX_RAW_EMAIL_SIZE) {
      return json({ error: "Message too large" }, 413)
    }
  }

  if (!request.body) {
    return json({ error: "Missing message body" }, 400)
  }

  const digest = createHash("sha256")
  digest.update("v1\0")
  digest.update(normalizedEnvelopeTo)
  digest.update("\0")
  digest.update(envelopeFrom.toLowerCase())
  digest.update("\0")

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let actualRawSize = 0
  let bodyReadTimedOut = false
  const bodyReadTimeoutId = setTimeout(() => {
    bodyReadTimedOut = true
    void reader.cancel("Request body read timed out").catch(() => undefined)
  }, BODY_READ_TIMEOUT)

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      actualRawSize += value.byteLength
      if (actualRawSize > MAX_RAW_EMAIL_SIZE) {
        await reader.cancel("Message too large")
        return json({ error: "Message too large" }, 413)
      }

      digest.update(value)
      chunks.push(value)
    }
  } catch (error) {
    if (!bodyReadTimedOut) throw error
  } finally {
    clearTimeout(bodyReadTimeoutId)
  }

  if (bodyReadTimedOut) {
    return json({ error: "Message body read timed out" }, 408)
  }

  if (actualRawSize !== declaredRawSize) {
    return json({ error: "Raw message size mismatch" }, 400)
  }

  const messageId = digest.digest("hex")
  const db = createDb()

  const duplicate = await db.query.messages.findFirst({
    where: eq(messages.id, messageId),
    columns: { id: true },
  })
  if (duplicate) {
    return json({ status: "duplicate", messageId }, 200)
  }

  const targetEmail = await db.query.emails.findFirst({
    where: and(
      eq(sql`LOWER(${emails.address})`, normalizedEnvelopeTo),
      gt(emails.expiresAt, new Date()),
    ),
  })
  if (!targetEmail) {
    return json({ status: "ignored", reason: "unknown_recipient" }, 200)
  }

  const rawMessage = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
    actualRawSize,
  )

  let parsedMessage
  try {
    parsedMessage = await PostalMime.parse(rawMessage)
  } catch (error) {
    console.error("Failed to parse incoming email", {
      messageId,
      recipient: envelopeTo,
      error: error instanceof Error ? error.message : String(error),
    })
    return json({ error: "Invalid email message" }, 422)
  }

  let savedMessage
  try {
    const inserted = await db
      .insert(messages)
      .values({
        id: messageId,
        emailId: targetEmail.id,
        fromAddress: envelopeFrom,
        toAddress: normalizedEnvelopeTo,
        subject: parsedMessage.subject || "(无主题)",
        content: parsedMessage.text || "",
        html: parsedMessage.html || "",
        type: "received",
      })
      .onConflictDoNothing({ target: messages.id })
      .returning()

    savedMessage = inserted[0]
  } catch (error) {
    console.error("Failed to store incoming email", {
      messageId,
      recipient: envelopeTo,
      error: error instanceof Error ? error.message : String(error),
    })
    return json({ error: "Failed to store email" }, 503)
  }

  if (!savedMessage) {
    return json({ status: "duplicate", messageId }, 200)
  }

  if (targetEmail.userId) {
    try {
      const webhook = await db.query.webhooks.findFirst({
        where: eq(webhooks.userId, targetEmail.userId),
      })

      if (webhook?.enabled) {
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
      }
    } catch (error) {
      console.error("Failed to send incoming email webhook", {
        messageId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return json({ status: "created", messageId }, 201)
}
