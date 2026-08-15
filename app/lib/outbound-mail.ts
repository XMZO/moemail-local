import nodemailer from "nodemailer"
import { z } from "zod"
import {
  getDomainPolicy,
  type DomainPolicy,
  type SmtpOutboundPolicy,
} from "./domain-policies"
import { normalizeMailboxDomain } from "./email-address"
import { htmlToPlainText } from "./mail-content"
import {
  MAX_OUTBOUND_RECIPIENTS,
  parseOutboundRecipients,
} from "./outbound-recipients"

export { MAX_OUTBOUND_RECIPIENTS } from "./outbound-recipients"

const outboundRecipientsSchema = z.union([
  z.string().max(20_000, "RECIPIENTS_TOO_LONG"),
  z.array(z.string().max(320, "RECIPIENT_TOO_LONG")).max(MAX_OUTBOUND_RECIPIENTS, "TOO_MANY_RECIPIENTS"),
]).transform((value, ctx) => {
  const parsed = parseOutboundRecipients(value)
  if (parsed.recipients.length === 0 && parsed.invalid.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "RECIPIENT_REQUIRED" })
    return z.NEVER
  }
  if (parsed.invalid.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "RECIPIENT_INVALID" })
    return z.NEVER
  }
  if (parsed.tooMany) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "TOO_MANY_RECIPIENTS" })
    return z.NEVER
  }
  return parsed.recipients
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
  // When enabled by an authorized caller, deliver a separate message to each
  // recipient so no recipient header exposes the rest of the list.
  privateRecipients: z.boolean().default(false),
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
  const deliveries = message.privateRecipients
    ? message.to.map(to => ({ from, to: [to], subject: message.subject, ...content }))
    : [{ from, to: message.to, subject: message.subject, ...content }]
  const response = await fetch(message.privateRecipients
    ? "https://api.resend.com/emails/batch"
    : "https://api.resend.com/emails", {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${policy.apiKey}`,
    },
    body: JSON.stringify(message.privateRecipients ? deliveries : deliveries[0]),
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

function smtpTransport(policy: SmtpOutboundPolicy, pooled = false) {
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
    ...(pooled ? {
      pool: true,
      maxConnections: 4,
      maxMessages: MAX_OUTBOUND_RECIPIENTS,
    } : {}),
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
  const transport = smtpTransport(policy, message.privateRecipients)
  const content = outboundContent(message)

  try {
    if (message.privateRecipients) {
      const results = await Promise.allSettled(message.to.map(to => (
        transport.sendMail({
          from: sender(policy.fromName, fromAddress),
          to: [to],
          subject: message.subject,
          ...content,
        })
      )))
      const failure = results.find(result => result.status === "rejected")
      if (failure?.status === "rejected") throw failure.reason
    } else {
      await transport.sendMail({
        from: sender(policy.fromName, fromAddress),
        to: message.to,
        subject: message.subject,
        ...content,
      })
    }
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
  } else if (policy.outbound.mode === "smtp") {
    await sendWithSmtp(policy.outbound, fromAddress, message)
  } else {
    const { getMailuIntegration } = await import("./mailu/config")
    const integration = await getMailuIntegration()
    if (!integration?.enabled) throw new Error("MAILU_INTEGRATION_DISABLED")
    const { sendWithMailu } = await import("./mailu/outbound")
    await sendWithMailu(integration, fromAddress, message)
  }
  return { message, mode: policy.outbound.mode }
}
