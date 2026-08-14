import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { getConfig } from "./config/runtime"

const TICKET_VERSION = "v1"
const TICKET_TTL_MS = 2 * 60 * 1000
const MAX_TICKET_LENGTH = 2_048

interface RegistrationLoginTicketPayload {
  version: 1
  username: string
  userId: string
  issuedAt: number
  expiresAt: number
  nonce: string
}

interface TicketOptions {
  now?: number
  secret?: string
}

function resolveSecret(override?: string) {
  const secret = override ?? getConfig().auth.secret
  if (!secret) throw new Error("AUTH_SECRET_REQUIRED")
  return secret
}

function sign(encodedPayload: string, secret: string) {
  return createHmac("sha256", secret)
    .update(`${TICKET_VERSION}.${encodedPayload}`, "utf8")
    .digest()
}

function decodeCanonicalBase64Url(value: string) {
  try {
    const decoded = Buffer.from(value, "base64url")
    return decoded.toString("base64url") === value ? decoded : null
  } catch {
    return null
  }
}

export function issueRegistrationLoginTicket(
  username: string,
  userId: string,
  options: TicketOptions = {},
) {
  const issuedAt = options.now ?? Date.now()
  const payload: RegistrationLoginTicketPayload = {
    version: 1,
    username,
    userId,
    issuedAt,
    expiresAt: issuedAt + TICKET_TTL_MS,
    nonce: randomBytes(16).toString("base64url"),
  }
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
  const signature = sign(encodedPayload, resolveSecret(options.secret)).toString("base64url")
  return `${TICKET_VERSION}.${encodedPayload}.${signature}`
}

export function verifyRegistrationLoginTicket(
  ticket: string | null | undefined,
  username: string,
  options: TicketOptions = {},
): { userId: string } | null {
  if (!ticket || ticket.length > MAX_TICKET_LENGTH) return null

  const parts = ticket.split(".")
  if (parts.length !== 3 || parts[0] !== TICKET_VERSION) return null

  const [, encodedPayload, encodedSignature] = parts
  const suppliedSignature = decodeCanonicalBase64Url(encodedSignature)
  if (!suppliedSignature) return null

  const expectedSignature = sign(encodedPayload, resolveSecret(options.secret))
  if (
    suppliedSignature.length !== expectedSignature.length
    || !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    return null
  }

  const payloadBytes = decodeCanonicalBase64Url(encodedPayload)
  if (!payloadBytes) return null

  let payload: unknown
  try {
    payload = JSON.parse(payloadBytes.toString("utf8"))
  } catch {
    return null
  }

  if (!payload || typeof payload !== "object") return null
  const candidate = payload as Partial<RegistrationLoginTicketPayload>
  const now = options.now ?? Date.now()
  if (
    candidate.version !== 1
    || candidate.username !== username
    || typeof candidate.userId !== "string"
    || !candidate.userId
    || !Number.isSafeInteger(candidate.issuedAt)
    || !Number.isSafeInteger(candidate.expiresAt)
    || typeof candidate.nonce !== "string"
    || candidate.nonce.length < 16
    || (candidate.issuedAt as number) > now
    || (candidate.expiresAt as number) <= now
    || (candidate.expiresAt as number) - (candidate.issuedAt as number) !== TICKET_TTL_MS
  ) {
    return null
  }

  return { userId: candidate.userId }
}
