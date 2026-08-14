import { randomUUID } from "node:crypto"
import { z } from "zod"
import { CONFIG_KEYS, getConfigValue, setConfigValues } from "../config-store"
import { normalizeMailboxAddress } from "../email-address"
import {
  defaultImapRealtime,
  imapRealtimeSchema,
  MAIL_SECURITY_MODES,
  SMTP_AUTH_METHODS,
} from "../domain-policies"

const host = z.string().trim().min(1).max(253)
  .refine(value => !/[\x00-\x20\x7f/@]/u.test(value), "MAILU_HOST_INVALID")
const mailbox = z.string().trim().min(1).max(512)
  .refine(value => !/[\r\n\0]/u.test(value), "MAILU_MAILBOX_INVALID")
const secret = z.string().min(1).max(4_096)
  .refine(value => !/[\r\n\0]/u.test(value), "MAILU_SECRET_INVALID")
const apiToken = z.string().min(4, "MAILU_API_TOKEN_TOO_SHORT").max(4_096)
  .refine(value => !/[\r\n\0]/u.test(value), "MAILU_SECRET_INVALID")

const apiBaseUrl = z.string().trim().max(2_048).transform((value, ctx) => {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "MAILU_API_URL_INVALID" })
    return z.NEVER
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "MAILU_API_URL_INVALID" })
    return z.NEVER
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "")
  return parsed.toString().replace(/\/$/u, "")
})

const collectorAddress = z.string().transform((value, ctx) => {
  const normalized = normalizeMailboxAddress(value)
  if (!normalized) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "MAILU_COLLECTOR_ADDRESS_INVALID" })
    return z.NEVER
  }
  return normalized
})

export const mailuIntegrationFieldsSchema = z.object({
  version: z.literal(1),
  integrationId: z.string().uuid(),
  enabled: z.boolean(),
  api: z.object({
    baseUrl: apiBaseUrl,
    token: apiToken,
    timeoutSeconds: z.number().int().min(2).max(60).default(15),
  }).strict(),
  collector: z.object({
    address: collectorAddress,
    password: secret,
  }).strict(),
  catchAll: z.object({
    address: collectorAddress,
    password: secret,
  }).strict(),
  imap: z.object({
    host,
    port: z.number().int().min(1).max(65_535),
    security: z.enum(MAIL_SECURITY_MODES),
    rejectUnauthorized: z.boolean(),
    mailbox,
    recipientHeader: z.enum(["x-original-to", "delivered-to", "envelope-to", "x-envelope-to"]),
    initialSync: z.enum(["new", "unseen"]),
    connectionTimeoutSeconds: z.number().int().min(5).max(120).default(15),
    realtime: imapRealtimeSchema.default(defaultImapRealtime(true)),
    pollIntervalSeconds: z.number().int().min(15).max(86_400),
    maxMessagesPerPoll: z.number().int().min(1).max(1_000),
  }).strict(),
  smtp: z.object({
    host,
    port: z.number().int().min(1).max(65_535),
    security: z.enum(MAIL_SECURITY_MODES),
    authMethod: z.enum(SMTP_AUTH_METHODS),
    rejectUnauthorized: z.boolean(),
    fromName: z.string().trim().max(128)
      .refine(value => !/[\r\n]/u.test(value), "FROM_NAME_INVALID")
      .nullable(),
  }).strict(),
  reconciliation: z.object({
    enabled: z.boolean(),
    intervalSeconds: z.number().int().min(30).max(86_400),
    createCatchAll: z.boolean(),
    removeStaleAliases: z.boolean(),
  }).strict(),
  retention: z.discriminatedUnion("action", [
    z.object({ action: z.literal("keep") }).strict(),
    z.object({
      action: z.literal("delete"),
      delaySeconds: z.number().int().min(0).max(2_592_000),
    }).strict(),
    z.object({
      action: z.literal("archive"),
      delaySeconds: z.number().int().min(0).max(2_592_000),
      mailbox,
    }).strict(),
  ]),
}).strict()

export const mailuIntegrationSchema = mailuIntegrationFieldsSchema.superRefine((integration, ctx) => {
  if (integration.enabled) {
    const placeholders: Array<[Array<string | number>, string]> = [
      [["api", "token"], integration.api.token],
      [["collector", "password"], integration.collector.password],
      [["catchAll", "password"], integration.catchAll.password],
    ]
    for (const [path, value] of placeholders) {
      if (value === "replace-me") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: "MAILU_PLACEHOLDER_SECRET_FORBIDDEN",
        })
      }
    }
  }
  if (integration.collector.address === integration.catchAll.address) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["catchAll", "address"],
      message: "MAILU_SERVICE_ACCOUNTS_MUST_DIFFER",
    })
  }
  if (integration.retention.action === "archive" && integration.retention.mailbox === integration.imap.mailbox) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["retention", "mailbox"],
      message: "MAILU_ARCHIVE_MAILBOX_MUST_DIFFER",
    })
  }
})

export type MailuIntegration = z.infer<typeof mailuIntegrationSchema>

export function defaultMailuIntegration(): MailuIntegration {
  return {
    version: 1,
    integrationId: randomUUID(),
    enabled: false,
    api: { baseUrl: "https://mail.example.com/api/v1", token: "replace-me", timeoutSeconds: 15 },
    collector: { address: "moemail-collector@example.com", password: "replace-me" },
    catchAll: { address: "moemail-catchall@example.com", password: "replace-me" },
    imap: {
      host: "mail.example.com",
      port: 993,
      security: "tls",
      rejectUnauthorized: true,
      mailbox: "INBOX",
      // Prefer Mailu's server-written Delivered-To. MoeMail also validates the
      // three-hop trace produced when Mailu 2024.06 aliases expose the
      // collector here instead of the original SMTP envelope recipient.
      recipientHeader: "delivered-to",
      initialSync: "new",
      connectionTimeoutSeconds: 15,
      realtime: defaultImapRealtime(true),
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 100,
    },
    smtp: {
      host: "mail.example.com",
      port: 465,
      security: "tls",
      authMethod: "auto",
      rejectUnauthorized: true,
      fromName: null,
    },
    reconciliation: {
      enabled: true,
      intervalSeconds: 300,
      createCatchAll: true,
      removeStaleAliases: true,
    },
    retention: { action: "delete", delaySeconds: 86_400 },
  }
}

export async function getMailuIntegration(): Promise<MailuIntegration | null> {
  const raw = await getConfigValue(CONFIG_KEYS.MAILU_INTEGRATION)
  if (!raw) return null
  try {
    return mailuIntegrationSchema.parse(JSON.parse(raw))
  } catch {
    throw new Error("MAILU_CONFIG_CORRUPTED")
  }
}

export async function saveMailuIntegration(input: unknown) {
  const integration = mailuIntegrationSchema.parse(input)
  await setConfigValues({ [CONFIG_KEYS.MAILU_INTEGRATION]: JSON.stringify(integration) })
  return integration
}
