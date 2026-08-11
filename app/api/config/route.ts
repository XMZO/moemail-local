import { hasPermission, PERMISSIONS, Role, ROLES } from "@/lib/permissions"
import { EMAIL_CONFIG } from "@/config"
import { CONFIG_KEYS, getConfigValues, setConfigValues } from "@/lib/config-store"
import { authorizeRequest } from "@/lib/request-auth"
import { normalizeMailboxDomain } from "@/lib/email-address"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request)
  if (!authorization.ok) return authorization.response

  const canManageConfig = hasPermission(
    authorization.principal.roles,
    PERMISSIONS.MANAGE_CONFIG
  )
  const config = await getConfigValues([
    CONFIG_KEYS.DEFAULT_ROLE,
    CONFIG_KEYS.EMAIL_DOMAINS,
    CONFIG_KEYS.ADMIN_CONTACT,
    CONFIG_KEYS.MAX_EMAILS,
    CONFIG_KEYS.TURNSTILE_ENABLED,
    CONFIG_KEYS.TURNSTILE_SITE_KEY,
    CONFIG_KEYS.TURNSTILE_SECRET_KEY,
  ])

  return Response.json({
    defaultRole: config.DEFAULT_ROLE || ROLES.CIVILIAN,
    emailDomains: config.EMAIL_DOMAINS || "moemail.app",
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
    emailDomains: string,
    adminContact: string,
    maxEmails: string,
    turnstile?: {
      enabled: boolean,
      siteKey: string,
      secretKey: string
    }
  }
  
  if (![ROLES.DUKE, ROLES.KNIGHT, ROLES.CIVILIAN].includes(defaultRole)) {
    return Response.json({ error: "无效的角色" }, { status: 400 })
  }

  const configuredDomains = typeof emailDomains === "string"
    ? emailDomains.split(",").map(domain => normalizeMailboxDomain(domain))
    : []
  if (
    configuredDomains.length === 0
    || configuredDomains.some(domain => !domain)
    || new Set(configuredDomains).size !== configuredDomains.length
  ) {
    return Response.json(
      { error: "邮箱域名必须是唯一、有效的 ASCII 域名" },
      { status: 400 },
    )
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
    EMAIL_DOMAINS: configuredDomains.join(","),
    ADMIN_CONTACT: adminContact,
    MAX_EMAILS: maxEmails,
    TURNSTILE_ENABLED: turnstileConfig.enabled.toString(),
    TURNSTILE_SITE_KEY: turnstileConfig.siteKey,
    TURNSTILE_SECRET_KEY: turnstileConfig.secretKey,
  })

  return Response.json({ success: true })
} 
