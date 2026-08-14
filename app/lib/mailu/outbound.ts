import nodemailer from "nodemailer"
import type { OutboundMessage } from "../outbound-mail"
import { MAX_OUTBOUND_RECIPIENTS, outboundContent } from "../outbound-mail"
import type { MailuIntegration } from "./config"
import { ensureMailuSenderAlias } from "./reconcile"

type MailuSmtpConnection = Pick<MailuIntegration, "collector" | "smtp">

function transport(integration: MailuSmtpConnection, pooled = false) {
  return nodemailer.createTransport({
    host: integration.smtp.host,
    port: integration.smtp.port,
    secure: integration.smtp.security === "tls",
    requireTLS: integration.smtp.security === "starttls",
    ignoreTLS: integration.smtp.security === "plain",
    auth: { user: integration.collector.address, pass: integration.collector.password },
    authMethod: integration.smtp.authMethod === "auto"
      ? undefined
      : integration.smtp.authMethod.toUpperCase(),
    tls: { rejectUnauthorized: integration.smtp.rejectUnauthorized },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    ...(pooled ? { pool: true, maxConnections: 4, maxMessages: MAX_OUTBOUND_RECIPIENTS } : {}),
    disableFileAccess: true,
    disableUrlAccess: true,
  })
}

export async function testMailuSmtpConnection(integration: MailuSmtpConnection) {
  const client = transport(integration)
  try {
    await client.verify()
    return { ok: true as const }
  } finally {
    client.close()
  }
}

export async function sendWithMailu(integration: MailuIntegration, fromAddress: string, message: OutboundMessage) {
  // Local ownership is enforced by the send route. This second check proves
  // Mailu has the exact managed alias that authorizes the collector account;
  // a catch-all must never grant arbitrary From addresses.
  await ensureMailuSenderAlias(integration, fromAddress)
  const client = transport(integration, message.privateRecipients)
  const content = outboundContent(message)
  const from = integration.smtp.fromName
    ? { name: integration.smtp.fromName, address: fromAddress }
    : fromAddress
  try {
    if (message.privateRecipients) {
      const results = await Promise.allSettled(message.to.map(to => client.sendMail({
        envelope: { from: fromAddress, to: [to] },
        from,
        to: [to],
        subject: message.subject,
        ...content,
      })))
      const failure = results.find(result => result.status === "rejected")
      if (failure?.status === "rejected") throw failure.reason
      return
    }
    await client.sendMail({
      envelope: { from: fromAddress, to: message.to },
      from,
      to: message.to,
      subject: message.subject,
      ...content,
    })
  } finally {
    client.close()
  }
}
