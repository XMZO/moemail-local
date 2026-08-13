import nodemailer from "nodemailer"
import { z } from "zod"
import {
  getDomainPolicy,
  type DomainPolicy,
  type SmtpOutboundPolicy,
} from "./domain-policies"
import { normalizeMailboxAddress, normalizeMailboxDomain } from "./email-address"
import { htmlToPlainText } from "./mail-content"

export const MAX_OUTBOUND_RECIPIENTS = 50

const outboundRecipientsSchema = z.union([
  z.string().max(20_000, "RECIPIENTS_TOO_LONG"),
  z.array(z.string().max(320, "RECIPIENT_TOO_LONG")).max(MAX_OUTBOUND_RECIPIENTS, "TOO_MANY_RECIPIENTS"),
]).transform((value, ctx) => {
  const parts = (Array.isArray(value) ? value : [value])
    .flatMap(item => item.split(/[;,]/u))
    .map(item => item.trim())

  if (parts.length === 0 || parts.some(part => part.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "RECIPIENT_REQUIRED" })
    return z.NEVER
  }

  const recipients: string[] = []
  const seen = new Set<string>()
  for (const part of parts) {
    if (part.length > 320 || /[\r\n]/u.test(part)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "RECIPIENT_INVALID" })
      return z.NEVER
    }
    const recipient = normalizeMailboxAddress(part)
    if (!recipient) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "RECIPIENT_INVALID" })
      return z.NEVER
    }
    if (!seen.has(recipient)) {
      seen.add(recipient)
      recipients.push(recipient)
    }
  }

  if (recipients.length > MAX_OUTBOUND_RECIPIENTS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "TOO_MANY_RECIPIENTS" })
    return z.NEVER
  }
  return recipients
})

export const outboundMessageSchema = z.object({
  to: outboundRecipientsSchema,
  subject: z.string()
    .trim()
    .min(1, "SUBJECT_REQUIRED")
    .max(998, "SUBJECT_TOO_LONG")
    .refine(value => !/[\r\n]/.test(value), "SUBJECT_INVALID"),
  content: z.string().min(1, "CONTENT_REQUIRED").max(2 * 1024 * 1024, "CONTENT_TOO_LARGE"),
  // Legacy API clients sent HTML without a format field. The WebUI always
  // sends an explicit value, while omission retains the pre-format contract.
  format: z.enum(["text", "html"]).default("html"),
}).strict()

export type OutboundMessage = z.infer<typeof outboundMessageSchema>

function senderDomain(address: string) {
  const separator = address.lastIndexOf("@")
  return separator > 0 ? normalizeMailboxDomain(address.slice(separator + 1)) : null
}

function sender(fromName: string | null, address: string) {
  return fromName ? { name: fromName, address } : address
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

export function outboundContent(message: OutboundMessage) {
  if (message.format === "html") {
    return {
      html: /<html(?:\s|>)/iu.test(message.content)
        ? message.content
        : `<!doctype html><html><head><meta charset="utf-8"></head><body>${message.content}</body></html>`,
      text: htmlToPlainText(message.content) || message.subject,
    }
  }
  return {
    text: message.content,
    html: `<!doctype html><html><head><meta charset="utf-8"></head><body><pre style="white-space:pre-wrap;font:inherit">${escapeHtml(message.content)}</pre></body></html>`,
  }
}

async function sendWithResend(
  policy: Extract<DomainPolicy["outbound"], { mode: "resend" }>,
  fromAddress: string,
  message: OutboundMessage,
) {
  const from = policy.fromName ? `${policy.fromName} <${fromAddress}>` : fromAddress
  const content = outboundContent(message)
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${policy.apiKey}`,
    },
    body: JSON.stringify({
      from,
      to: message.to,
      subject: message.subject,
      ...content,
    }),
    signal: AbortSignal.timeout(20_000),
  })

  if (!response.ok) {
    console.error("outbound.resend.failed", {
      status: response.status,
      provider: "resend",
    })
    throw new Error(`RESEND_SEND_FAILED:${response.status}`)
  }
}

function smtpTransport(policy: SmtpOutboundPolicy) {
  const auth = policy.username && policy.password
    ? { user: policy.username, pass: policy.password }
    : undefined
  return nodemailer.createTransport({
    host: policy.host,
    port: policy.port,
    secure: policy.security === "tls",
    requireTLS: policy.security === "starttls",
    ignoreTLS: policy.security === "plain",
    auth,
    authMethod: auth && policy.authMethod !== "auto"
      ? policy.authMethod.toUpperCase()
      : undefined,
    tls: { rejectUnauthorized: policy.rejectUnauthorized },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  })
}

export async function testSmtpConnection(policy: SmtpOutboundPolicy) {
  const transport = smtpTransport(policy)
  try {
    await transport.verify()
    return { ok: true as const }
  } finally {
    transport.close()
  }
}

async function sendWithSmtp(
  policy: SmtpOutboundPolicy,
  fromAddress: string,
  message: OutboundMessage,
) {
  const transport = smtpTransport(policy)
  const content = outboundContent(message)

  try {
    await transport.sendMail({
      from: sender(policy.fromName, fromAddress),
      to: message.to,
      subject: message.subject,
      ...content,
    })
  } finally {
    transport.close()
  }
}

export async function resolveOutboundPolicy(fromAddress: string) {
  const domain = senderDomain(fromAddress)
  return domain ? getDomainPolicy(domain) : null
}

export async function sendOutboundMessage(
  fromAddress: string,
  input: unknown,
  resolvedPolicy?: DomainPolicy,
) {
  const message = outboundMessageSchema.parse(input)
  const policy = resolvedPolicy ?? await resolveOutboundPolicy(fromAddress)
  if (!policy) throw new Error("OUTBOUND_DOMAIN_NOT_CONFIGURED")
  if (policy.outbound.mode === "disabled") throw new Error("OUTBOUND_DISABLED")

  if (policy.outbound.mode === "resend") {
    await sendWithResend(policy.outbound, fromAddress, message)
  } else {
    await sendWithSmtp(policy.outbound, fromAddress, message)
  }
  return { message, mode: policy.outbound.mode }
}
