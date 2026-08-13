import { z } from "zod"
import { normalizeMailboxDomain } from "./email-address"
import {
  CONFIG_KEYS,
  getConfigValue,
  getConfigValues,
  setConfigValues,
} from "./config-store"

export const INBOUND_MODES = ["worker", "imap", "disabled"] as const
export const OUTBOUND_MODES = ["resend", "smtp", "disabled"] as const
export const MAIL_SECURITY_MODES = ["plain", "starttls", "tls"] as const
export const SMTP_SECURITY_MODES = MAIL_SECURITY_MODES
export const SMTP_AUTH_METHODS = ["auto", "plain", "login"] as const
export const IMAP_INITIAL_SYNC_MODES = ["new", "unseen"] as const
export const IMAP_RECIPIENT_HEADERS = [
  "auto",
  "x-original-to",
  "delivered-to",
  "envelope-to",
  "x-envelope-to",
] as const

const optionalText = (maximum: number) => z
  .union([z.string(), z.null(), z.undefined()])
  .transform(value => {
    const trimmed = typeof value === "string" ? value.trim() : ""
    return trimmed || null
  })
  .refine(value => value === null || value.length <= maximum, "TEXT_TOO_LONG")

const mailHost = z.string()
  .trim()
  .min(1, "MAIL_HOST_REQUIRED")
  .max(253, "MAIL_HOST_TOO_LONG")
  .refine(value => !/[\x00-\x20\x7f/@]/.test(value), "MAIL_HOST_INVALID")

export const smtpOutboundSchema = z.object({
  mode: z.literal("smtp"),
  host: mailHost,
  port: z.number().int().min(1).max(65_535),
  security: z.enum(SMTP_SECURITY_MODES),
  authMethod: z.enum(SMTP_AUTH_METHODS).default("auto"),
  username: optionalText(512),
  password: optionalText(4_096),
  rejectUnauthorized: z.boolean(),
  fromName: optionalText(128).refine(
    value => value === null || !/[\r\n]/.test(value),
    "FROM_NAME_INVALID",
  ),
}).strict()

export type SmtpOutboundPolicy = z.infer<typeof smtpOutboundSchema>

export const imapInboundSchema = z.object({
  mode: z.literal("imap"),
  host: mailHost,
  port: z.number().int().min(1).max(65_535),
  security: z.enum(MAIL_SECURITY_MODES),
  username: z.string().trim().min(1, "IMAP_USERNAME_REQUIRED").max(512),
  password: z.string().min(1, "IMAP_PASSWORD_REQUIRED").max(4_096),
  rejectUnauthorized: z.boolean(),
  mailbox: z.string().trim().min(1, "IMAP_MAILBOX_REQUIRED").max(512)
    .refine(value => !/[\r\n\0]/.test(value), "IMAP_MAILBOX_INVALID"),
  recipientHeader: z.enum(IMAP_RECIPIENT_HEADERS),
  initialSync: z.enum(IMAP_INITIAL_SYNC_MODES),
  pollIntervalSeconds: z.number().int().min(15).max(86_400),
  maxMessagesPerPoll: z.number().int().min(1).max(1_000),
}).strict()

export type ImapInboundPolicy = z.infer<typeof imapInboundSchema>

const workerInboundSchema = z.object({ mode: z.literal("worker") }).strict()
const disabledInboundSchema = z.object({ mode: z.literal("disabled") }).strict()

const resendOutboundSchema = z.object({
  mode: z.literal("resend"),
  apiKey: z.string().trim().min(1, "RESEND_API_KEY_REQUIRED").max(4_096),
  fromName: optionalText(128).refine(
    value => value === null || !/[\r\n]/.test(value),
    "FROM_NAME_INVALID",
  ),
}).strict()

const disabledOutboundSchema = z.object({
  mode: z.literal("disabled"),
}).strict()

const domainPolicySchema = z.object({
  domain: z.string().transform((value, ctx) => {
    const normalized = normalizeMailboxDomain(value)
    if (!normalized) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "INVALID_MAIL_DOMAIN" })
      return z.NEVER
    }
    return normalized
  }),
  inbound: z.discriminatedUnion("mode", [
    workerInboundSchema,
    imapInboundSchema,
    disabledInboundSchema,
  ]),
  outbound: z.discriminatedUnion("mode", [
    resendOutboundSchema,
    smtpOutboundSchema,
    disabledOutboundSchema,
  ]),
}).strict()

export const domainPoliciesSchema = z.array(domainPolicySchema)
  .min(1, "MAIL_DOMAIN_REQUIRED")
  .max(100, "MAIL_DOMAIN_LIMIT_EXCEEDED")
  .superRefine((policies, ctx) => {
    const seen = new Set<string>()
    policies.forEach((policy, index) => {
      if (seen.has(policy.domain)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "domain"],
          message: "DUPLICATE_MAIL_DOMAIN",
        })
      }
      seen.add(policy.domain)

      if (policy.inbound.mode === "disabled" && policy.outbound.mode === "disabled") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: "MAIL_DOMAIN_TRANSPORT_REQUIRED",
        })
      }

      if (
        policy.outbound.mode === "smtp"
        && Boolean(policy.outbound.username) !== Boolean(policy.outbound.password)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "outbound", policy.outbound.username ? "password" : "username"],
          message: "SMTP_CREDENTIAL_PAIR_REQUIRED",
        })
      }
    })
  })

export type DomainPolicy = z.infer<typeof domainPolicySchema>
export type DomainPolicies = z.infer<typeof domainPoliciesSchema>

function parseStoredPolicies(raw: string) {
  let input: unknown
  try {
    input = JSON.parse(raw)
  } catch {
    throw new Error("DOMAIN_POLICIES_CORRUPTED")
  }

  const result = domainPoliciesSchema.safeParse(input)
  if (!result.success) {
    throw new Error(`DOMAIN_POLICIES_INVALID:${result.error.issues[0]?.message ?? "UNKNOWN"}`)
  }
  return result.data
}

async function legacyPolicies(): Promise<DomainPolicies> {
  const values = await getConfigValues([
    CONFIG_KEYS.EMAIL_DOMAINS,
    CONFIG_KEYS.EMAIL_SERVICE_ENABLED,
    CONFIG_KEYS.RESEND_API_KEY,
  ])
  const domains = (values.EMAIL_DOMAINS || "moemail.app")
    .split(",")
    .map(normalizeMailboxDomain)
    .filter((domain): domain is string => Boolean(domain))
  const uniqueDomains = [...new Set(domains.length > 0 ? domains : ["moemail.app"])]
  const resendEnabled = values.EMAIL_SERVICE_ENABLED === "true" && Boolean(values.RESEND_API_KEY)

  return uniqueDomains.map(domain => ({
    domain,
    inbound: { mode: "worker" as const },
    outbound: resendEnabled
      ? { mode: "resend" as const, apiKey: values.RESEND_API_KEY as string, fromName: null }
      : { mode: "disabled" as const },
  }))
}

export async function getDomainPolicies(): Promise<DomainPolicies> {
  const raw = await getConfigValue(CONFIG_KEYS.EMAIL_DOMAIN_POLICIES)
  return raw ? parseStoredPolicies(raw) : legacyPolicies()
}

export async function getDomainPolicy(domain: string): Promise<DomainPolicy | null> {
  const normalized = normalizeMailboxDomain(domain)
  if (!normalized) return null
  return (await getDomainPolicies()).find(policy => policy.domain === normalized) ?? null
}

export async function saveDomainPolicies(input: unknown): Promise<DomainPolicies> {
  const policies = domainPoliciesSchema.parse(input)
  await setConfigValues({
    [CONFIG_KEYS.EMAIL_DOMAIN_POLICIES]: JSON.stringify(policies),
    // 兼容仍读取旧公开域名键的客户端；运行时权威来源是上面的强类型策略。
    [CONFIG_KEYS.EMAIL_DOMAINS]: policies.map(policy => policy.domain).join(","),
  })
  return policies
}

export function publicDomainPolicy(policy: DomainPolicy) {
  return {
    domain: policy.domain,
    inboundMode: policy.inbound.mode,
    outboundMode: policy.outbound.mode,
  }
}
