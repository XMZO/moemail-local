import { createHash, timingSafeEqual } from "node:crypto"
import { getConfig, isSetupCompleted } from "@/lib/config/runtime"
import {
  ingestEmail,
  InboundIngestionError,
  MAX_RAW_EMAIL_SIZE,
} from "@/lib/email-ingestion"
import { normalizeMailboxAddress } from "@/lib/email-address"
import { apiErrorBody } from "@/lib/api-response"

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
    void reader.cancel("MESSAGE_BODY_TIMEOUT").catch(() => undefined)
  }, BODY_READ_TIMEOUT)

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RAW_EMAIL_SIZE) {
        await reader.cancel("MESSAGE_TOO_LARGE")
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
  if (!isSetupCompleted()) return json(apiErrorBody("EMAIL_INGESTION_UNAVAILABLE"), 503)
  const ingestSecret = getConfig().email.ingestSecret
  if (!ingestSecret) return json(apiErrorBody("EMAIL_INGESTION_UNAVAILABLE"), 503)
  if (!isAuthorized(request.headers.get("authorization"), ingestSecret)) {
    return json(apiErrorBody("UNAUTHORIZED"), 401)
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
  if (contentType !== CONTENT_TYPE) return json(apiErrorBody("UNSUPPORTED_MEDIA_TYPE"), 415)

  const envelopeFrom = getEnvelopeHeader(request, "x-moemail-envelope-from", true)
  const envelopeTo = getEnvelopeHeader(request, "x-moemail-envelope-to")
  if (envelopeFrom === null || envelopeTo === null) return json(apiErrorBody("INVALID_ENVELOPE"), 400)
  if (!normalizeMailboxAddress(envelopeTo)) return json(apiErrorBody("INVALID_ENVELOPE_RECIPIENT"), 400)

  const declaredSizeHeader = request.headers.get("x-moemail-raw-size")
  if (!declaredSizeHeader || !/^\d+$/.test(declaredSizeHeader)) {
    return json(apiErrorBody("INVALID_RAW_MESSAGE_SIZE"), 400)
  }
  const declaredSize = Number(declaredSizeHeader)
  if (!Number.isSafeInteger(declaredSize)) return json(apiErrorBody("INVALID_RAW_MESSAGE_SIZE"), 400)
  if (declaredSize > MAX_RAW_EMAIL_SIZE) return json(apiErrorBody("MESSAGE_TOO_LARGE"), 413)

  const contentLength = request.headers.get("content-length")
  if (contentLength !== null) {
    const parsed = Number(contentLength)
    if (!Number.isSafeInteger(parsed) || parsed < 0) return json(apiErrorBody("INVALID_CONTENT_LENGTH"), 400)
    if (parsed > MAX_RAW_EMAIL_SIZE) return json(apiErrorBody("MESSAGE_TOO_LARGE"), 413)
  }

  try {
    const raw = await readRawMessage(request)
    if (raw.byteLength !== declaredSize) return json(apiErrorBody("RAW_MESSAGE_SIZE_MISMATCH"), 400)
    const result = await ingestEmail({ raw, envelopeFrom, envelopeTo, transport: "worker" })
    if (result.status === "created") return json(result, 201)
    if (result.status === "duplicate" || result.status === "ignored") return json(result, 200)
    if (result.reason === "quota_exceeded") {
      return json(apiErrorBody(result.code, { status: "rejected", reason: result.code }), 429)
    }
    if (result.reason === "message_too_large") {
      return json(apiErrorBody(result.code, { status: "rejected", reason: result.code }), 413)
    }
    return json(
      apiErrorBody(result.code, { status: "rejected", reason: result.code }),
      result.reason === "permission_denied" ? 403 : 409,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown"
    if (message === "message_too_large") return json(apiErrorBody("MESSAGE_TOO_LARGE"), 413)
    if (message === "body_timeout") return json(apiErrorBody("MESSAGE_BODY_TIMEOUT"), 408)
    if (message === "missing_body") return json(apiErrorBody("MESSAGE_BODY_MISSING"), 400)
    if (error instanceof InboundIngestionError) {
      return json(
        apiErrorBody(error.code),
        error.code === "INVALID_ENVELOPE_RECIPIENT" ? 400 : 422,
      )
    }
    console.error("ingest.worker.failed", { error: message.slice(0, 500) })
    return json(apiErrorBody("EMAIL_STORE_FAILED"), 503)
  }
}
