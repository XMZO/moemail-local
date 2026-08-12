import { createHash, timingSafeEqual } from "node:crypto"
import { getConfig, isSetupCompleted } from "@/lib/config/runtime"
import { ingestEmail, MAX_RAW_EMAIL_SIZE } from "@/lib/email-ingestion"
import { normalizeMailboxAddress } from "@/lib/email-address"

export const runtime = "nodejs"

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
  if ((!allowEmpty && !value) || value.length > 512 || /[\r\n]/.test(value)) return null
  return value
}

async function readRawMessage(request: Request) {
  if (!request.body) throw new Error("missing_body")
  const reader = request.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    void reader.cancel("Request body read timed out").catch(() => undefined)
  }, BODY_READ_TIMEOUT)

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RAW_EMAIL_SIZE) {
        await reader.cancel("Message too large")
        throw new Error("message_too_large")
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
    }
  } catch (error) {
    if (timedOut) throw new Error("body_timeout")
    throw error
  } finally {
    clearTimeout(timeout)
  }
  if (timedOut) throw new Error("body_timeout")
  return Buffer.concat(chunks, total)
}

export async function POST(request: Request) {
  if (!isSetupCompleted()) return json({ error: "Email ingestion is unavailable" }, 503)
  const ingestSecret = getConfig().email.ingestSecret
  if (!ingestSecret) return json({ error: "Email ingestion is unavailable" }, 503)
  if (!isAuthorized(request.headers.get("authorization"), ingestSecret)) {
    return json({ error: "Unauthorized" }, 401)
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
  if (contentType !== CONTENT_TYPE) return json({ error: "Unsupported media type" }, 415)

  const envelopeFrom = getEnvelopeHeader(request, "x-moemail-envelope-from", true)
  const envelopeTo = getEnvelopeHeader(request, "x-moemail-envelope-to")
  if (envelopeFrom === null || envelopeTo === null) return json({ error: "Invalid envelope" }, 400)
  if (!normalizeMailboxAddress(envelopeTo)) return json({ error: "Invalid envelope recipient" }, 400)

  const declaredSizeHeader = request.headers.get("x-moemail-raw-size")
  if (!declaredSizeHeader || !/^\d+$/.test(declaredSizeHeader)) {
    return json({ error: "Invalid raw message size" }, 400)
  }
  const declaredSize = Number(declaredSizeHeader)
  if (!Number.isSafeInteger(declaredSize)) return json({ error: "Invalid raw message size" }, 400)
  if (declaredSize > MAX_RAW_EMAIL_SIZE) return json({ error: "Message too large" }, 413)

  const contentLength = request.headers.get("content-length")
  if (contentLength !== null) {
    const parsed = Number(contentLength)
    if (!Number.isSafeInteger(parsed) || parsed < 0) return json({ error: "Invalid content length" }, 400)
    if (parsed > MAX_RAW_EMAIL_SIZE) return json({ error: "Message too large" }, 413)
  }

  try {
    const raw = await readRawMessage(request)
    if (raw.byteLength !== declaredSize) return json({ error: "Raw message size mismatch" }, 400)
    const result = await ingestEmail({ raw, envelopeFrom, envelopeTo, transport: "worker" })
    if (result.status === "created") return json(result, 201)
    if (result.status === "duplicate" || result.status === "ignored") return json(result, 200)
    if (result.reason === "quota_exceeded") {
      return json({ status: "rejected", reason: result.reason }, 429)
    }
    if (result.reason === "message_too_large") {
      return json({ status: "rejected", reason: result.reason }, 413)
    }
    return json(
      { status: "rejected", reason: result.reason },
      result.reason === "permission_denied" ? 403 : 409,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown"
    if (message === "message_too_large") return json({ error: "Message too large" }, 413)
    if (message === "body_timeout") return json({ error: "Message body read timed out" }, 408)
    if (message === "missing_body") return json({ error: "Missing message body" }, 400)
    if (message === "Invalid email message") return json({ error: message }, 422)
    console.error("ingest.worker.failed", { error: message.slice(0, 500) })
    return json({ error: "Failed to store email" }, 503)
  }
}
