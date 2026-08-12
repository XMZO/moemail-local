import nodemailer from "nodemailer"
import { z } from "zod"
import {
  getDomainPolicy,
  type DomainPolicy,
  type SmtpOutboundPolicy,
} from "./domain-policies"
import { normalizeMailboxAddress, normalizeMailboxDomain } from "./email-address"

export const outboundMessageSchema = z.object({
  to: z.string()
    .trim()
    .min(3, "收件人不能为空")
    .max(320, "收件人地址过长")
    .refine(value => !/[\r\n]/.test(value), "收件人地址格式无效")
    .refine(value => Boolean(normalizeMailboxAddress(value)), "收件人地址格式无效"),
  subject: z.string()
    .trim()
    .min(1, "主题不能为空")
    .max(998, "主题过长")
    .refine(value => !/[\r\n]/.test(value), "主题不能包含换行"),
  content: z.string().min(1, "内容不能为空").max(2 * 1024 * 1024, "邮件内容过大"),
}).strict()

export type OutboundMessage = z.infer<typeof outboundMessageSchema>

function senderDomain(address: string) {
  const separator = address.lastIndexOf("@")
  return separator > 0 ? normalizeMailboxDomain(address.slice(separator + 1)) : null
}

function sender(fromName: string | null, address: string) {
  return fromName ? { name: fromName, address } : address
}

async function sendWithResend(
  policy: Extract<DomainPolicy["outbound"], { mode: "resend" }>,
  fromAddress: string,
  message: OutboundMessage,
) {
  const from = policy.fromName ? `${policy.fromName} <${fromAddress}>` : fromAddress
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${policy.apiKey}`,
    },
    body: JSON.stringify({
      from,
      to: [message.to],
      subject: message.subject,
      html: message.content,
    }),
    signal: AbortSignal.timeout(20_000),
  })

  if (!response.ok) {
    let providerMessage = ""
    try {
      const body = await response.json() as { message?: unknown }
      providerMessage = typeof body.message === "string" ? body.message.slice(0, 500) : ""
    } catch {
      // Provider error bodies are optional and must not block the generic failure path.
    }
    console.error("outbound.resend.failed", {
      status: response.status,
      provider: "resend",
    })
    throw new Error(providerMessage || `Resend 发件失败 (${response.status})`)
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

  try {
    await transport.sendMail({
      from: sender(policy.fromName, fromAddress),
      to: message.to,
      subject: message.subject,
      html: message.content,
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
  if (!policy) throw new Error("发件域名未配置")
  if (policy.outbound.mode === "disabled") throw new Error("该域名未启用发件")

  if (policy.outbound.mode === "resend") {
    await sendWithResend(policy.outbound, fromAddress, message)
  } else {
    await sendWithSmtp(policy.outbound, fromAddress, message)
  }
  return { message, mode: policy.outbound.mode }
}
