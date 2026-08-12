import { PERMISSIONS, Role, ROLES } from "@/lib/permissions"
import { EMAIL_CONFIG } from "@/config"
import { CONFIG_KEYS, getConfigValues, setConfigValues } from "@/lib/config-store"
import { authorizeRequest } from "@/lib/request-auth"
import { normalizeMailboxDomain } from "@/lib/email-address"
import { getDomainPolicies, saveDomainPolicies } from "@/lib/domain-policies"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request)
  if (!authorization.ok) return authorization.response

  const canManageConfig = authorization.principal.access.permissions[PERMISSIONS.MANAGE_CONFIG]
  const [config, domainPolicies] = await Promise.all([
    getConfigValues([
    CONFIG_KEYS.DEFAULT_ROLE,
    CONFIG_KEYS.ADMIN_CONTACT,
    CONFIG_KEYS.MAX_EMAILS,
    CONFIG_KEYS.TURNSTILE_ENABLED,
    CONFIG_KEYS.TURNSTILE_SITE_KEY,
    CONFIG_KEYS.TURNSTILE_SECRET_KEY,
    ]),
    getDomainPolicies(),
  ])

  return Response.json({
    defaultRole: config.DEFAULT_ROLE || ROLES.CIVILIAN,
    emailDomains: domainPolicies.map(policy => policy.domain).join(","),
    domains: domainPolicies.map(policy => ({
      domain: policy.domain,
      inboundMode: policy.inbound.mode,
      outboundMode: policy.outbound.mode,
    })),
    adminContact: config.ADMIN_CONTACT || "",
    maxEmails: config.MAX_EMAILS || EMAIL_CONFIG.MAX_ACTIVE_EMAILS.toString(),
    turnstile: canManageConfig ? {
      enabled: config.TURNSTILE_ENABLED === "true",
      siteKey: config.TURNSTILE_SITE_KEY || "",
      secretKey: config.TURNSTILE_SECRET_KEY || "",
    } : undefined
  })
}

export async function POST(request: Request) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.MANAGE_CONFIG,
  })
  if (!authorization.ok) return authorization.response

  const {
    defaultRole,
    emailDomains,
    adminContact,
    maxEmails,
    turnstile
  } = await request.json() as { 
    defaultRole: Exclude<Role, typeof ROLES.EMPEROR>,
    emailDomains?: string,
    adminContact: string,
    maxEmails?: string,
    turnstile?: {
      enabled: boolean,
      siteKey: string,
      secretKey: string
    }
  }
  
  if (![ROLES.DUKE, ROLES.KNIGHT, ROLES.CIVILIAN].includes(defaultRole)) {
    return Response.json({ error: "无效的角色" }, { status: 400 })
  }

  let configuredDomains: string[] | null = null
  if (emailDomains !== undefined) {
    const normalizedDomains = typeof emailDomains === "string"
      ? emailDomains.split(",").map(domain => normalizeMailboxDomain(domain))
      : []
    if (
      normalizedDomains.length === 0
      || normalizedDomains.some(domain => !domain)
      || new Set(normalizedDomains).size !== normalizedDomains.length
    ) {
      return Response.json(
        { error: "邮箱域名必须是唯一、有效的 ASCII 域名" },
        { status: 400 },
      )
    }
    configuredDomains = normalizedDomains as string[]
  }

  let parsedMaxEmails: number | null = null
  if (maxEmails !== undefined) {
    parsedMaxEmails = Number(maxEmails)
    if (!Number.isSafeInteger(parsedMaxEmails) || parsedMaxEmails < 1 || parsedMaxEmails > 100_000) {
      return Response.json(
        { error: "最大邮箱数量必须是 1-100000 的整数" },
        { status: 400 },
      )
    }
  }

  const turnstileConfig = turnstile ?? {
    enabled: false,
    siteKey: "",
    secretKey: ""
  }

  if (turnstileConfig.enabled && (!turnstileConfig.siteKey || !turnstileConfig.secretKey)) {
    return Response.json({ error: "Turnstile 启用时需要提供 Site Key 和 Secret Key" }, { status: 400 })
  }

  await setConfigValues({
    DEFAULT_ROLE: defaultRole,
    ADMIN_CONTACT: adminContact,
    ...(parsedMaxEmails === null ? {} : { MAX_EMAILS: parsedMaxEmails.toString() }),
    TURNSTILE_ENABLED: turnstileConfig.enabled.toString(),
    TURNSTILE_SITE_KEY: turnstileConfig.siteKey,
    TURNSTILE_SECRET_KEY: turnstileConfig.secretKey,
  })

  if (configuredDomains) {
    const currentPolicies = await getDomainPolicies()
    await saveDomainPolicies(configuredDomains.map(domain => (
      currentPolicies.find(policy => policy.domain === domain) ?? {
        domain,
        inbound: { mode: "worker" as const },
        outbound: { mode: "disabled" as const },
      }
    )))
  }

  return Response.json({ success: true })
} 
