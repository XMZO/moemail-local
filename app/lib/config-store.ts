import { inArray, sql } from "drizzle-orm"
import { createDb } from "./db"
import { siteConfig } from "./local-schema"

export const CONFIG_KEYS = {
  DEFAULT_ROLE: "DEFAULT_ROLE",
  EMAIL_DOMAINS: "EMAIL_DOMAINS",
  ADMIN_CONTACT: "ADMIN_CONTACT",
  MAX_EMAILS: "MAX_EMAILS",
  TURNSTILE_ENABLED: "TURNSTILE_ENABLED",
  TURNSTILE_SITE_KEY: "TURNSTILE_SITE_KEY",
  TURNSTILE_SECRET_KEY: "TURNSTILE_SECRET_KEY",
  EMAIL_SERVICE_ENABLED: "EMAIL_SERVICE_ENABLED",
  RESEND_API_KEY: "RESEND_API_KEY",
  EMAIL_ROLE_LIMITS: "EMAIL_ROLE_LIMITS",
  EMAIL_DOMAIN_POLICIES: "EMAIL_DOMAIN_POLICIES",
  IMAP_SYNC_STATE: "IMAP_SYNC_STATE",
  MAILU_INTEGRATION: "MAILU_INTEGRATION",
  MAILU_IMAP_STATE: "MAILU_IMAP_STATE",
  ACCESS_POLICIES: "ACCESS_POLICIES",
  UI_FONT_FAMILY: "UI_FONT_FAMILY",
  APPEARANCE_ADVANCED_ENABLED: "APPEARANCE_ADVANCED_ENABLED",
  APPEARANCE_CUSTOM_CSS: "APPEARANCE_CUSTOM_CSS",
  APPEARANCE_HEAD_HTML: "APPEARANCE_HEAD_HTML",
  APPEARANCE_BODY_END_HTML: "APPEARANCE_BODY_END_HTML",
  APPEARANCE_CUSTOM_JS: "APPEARANCE_CUSTOM_JS",
  APPEARANCE_CUSTOM_JS_ENABLED: "APPEARANCE_CUSTOM_JS_ENABLED",
} as const

export type ConfigKey = typeof CONFIG_KEYS[keyof typeof CONFIG_KEYS]

export async function getConfigValue(key: ConfigKey): Promise<string | null> {
  const row = await createDb().query.siteConfig.findFirst({
    where: (config, { eq }) => eq(config.key, key),
    columns: { value: true },
  })
  return row?.value ?? null
}

export async function getConfigValues(keys: readonly ConfigKey[]) {
  const values = Object.fromEntries(keys.map(key => [key, null])) as Record<ConfigKey, string | null>
  if (keys.length === 0) return values

  const rows = await createDb()
    .select({ key: siteConfig.key, value: siteConfig.value })
    .from(siteConfig)
    .where(inArray(siteConfig.key, [...keys]))

  for (const row of rows) {
    values[row.key as ConfigKey] = row.value
  }

  return values
}

export async function setConfigValues(values: Partial<Record<ConfigKey, string>>) {
  const entries = Object.entries(values) as [ConfigKey, string][]
  if (entries.length === 0) return

  const db = createDb()
  const now = new Date()

  await db.insert(siteConfig)
    .values(entries.map(([key, value]) => ({ key, value, updatedAt: now })))
    .onConflictDoUpdate({
      target: siteConfig.key,
      set: {
        value: sql`excluded.value`,
        updatedAt: sql`excluded.updated_at`,
      },
    })
}
