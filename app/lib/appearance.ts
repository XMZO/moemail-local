import { CONFIG_KEYS, getConfigValue, getConfigValues, setConfigValues } from "./config-store"
import {
  DEFAULT_APPEARANCE_CONFIG,
  DEFAULT_UI_FONT_FAMILY,
  MAX_APPEARANCE_FRAGMENT_BYTES,
  MAX_APPEARANCE_TOTAL_BYTES,
  type AppearanceConfig,
} from "./appearance-values"

export { DEFAULT_APPEARANCE_CONFIG, DEFAULT_UI_FONT_FAMILY } from "./appearance-values"

export function parseUiFontFamily(value: unknown) {
  if (typeof value !== "string") throw new Error("FONT_FAMILY_STRING_REQUIRED")
  const trimmed = value.trim()
  if (!trimmed) return DEFAULT_UI_FONT_FAMILY
  if (trimmed.length > 200) throw new Error("FONT_FAMILY_TOO_LONG")
  if (
    /[;{}<>\r\n\\]/.test(trimmed)
    || /(?:url|expression|image-set)\s*\(/i.test(trimmed)
  ) {
    throw new Error("FONT_FAMILY_UNSAFE")
  }
  return trimmed
}

export async function getUiFontFamily() {
  const stored = await getConfigValue(CONFIG_KEYS.UI_FONT_FAMILY)
  return stored ? parseUiFontFamily(stored) : DEFAULT_UI_FONT_FAMILY
}

export async function saveUiFontFamily(value: unknown) {
  const fontFamily = parseUiFontFamily(value)
  await setConfigValues({ [CONFIG_KEYS.UI_FONT_FAMILY]: fontFamily })
  return fontFamily
}

const appearanceKeys = [
  CONFIG_KEYS.UI_FONT_FAMILY,
  CONFIG_KEYS.APPEARANCE_ADVANCED_ENABLED,
  CONFIG_KEYS.APPEARANCE_CUSTOM_CSS,
  CONFIG_KEYS.APPEARANCE_HEAD_HTML,
  CONFIG_KEYS.APPEARANCE_BODY_END_HTML,
  CONFIG_KEYS.APPEARANCE_CUSTOM_JS,
  CONFIG_KEYS.APPEARANCE_CUSTOM_JS_ENABLED,
] as const

function parseAppearanceFragment(value: unknown, label: string) {
  if (typeof value !== "string") throw new Error(`${label}_STRING_REQUIRED`)
  const normalized = value.replace(/\r\n?/g, "\n")
  if (normalized.includes("\0")) throw new Error(`${label}_CONTAINS_NUL`)
  if (Buffer.byteLength(normalized, "utf8") > MAX_APPEARANCE_FRAGMENT_BYTES) {
    throw new Error(`${label}_TOO_LARGE`)
  }
  return normalized
}

function parseAppearanceBoolean(value: unknown, label: string) {
  if (typeof value !== "boolean") throw new Error(`${label}_BOOLEAN_REQUIRED`)
  return value
}

export async function getAppearanceConfig(): Promise<AppearanceConfig> {
  const values = await getConfigValues(appearanceKeys)
  return {
    fontFamily: values.UI_FONT_FAMILY
      ? parseUiFontFamily(values.UI_FONT_FAMILY)
      : DEFAULT_APPEARANCE_CONFIG.fontFamily,
    advancedEnabled: values.APPEARANCE_ADVANCED_ENABLED === "true",
    customCss: values.APPEARANCE_CUSTOM_CSS ?? "",
    headHtml: values.APPEARANCE_HEAD_HTML ?? "",
    bodyEndHtml: values.APPEARANCE_BODY_END_HTML ?? "",
    customJs: values.APPEARANCE_CUSTOM_JS ?? "",
    customJsEnabled: values.APPEARANCE_CUSTOM_JS_ENABLED === "true",
  }
}

export async function saveAppearanceConfig(input: Partial<Record<keyof AppearanceConfig, unknown>>) {
  const current = await getAppearanceConfig()
  const next: AppearanceConfig = {
    fontFamily: input.fontFamily === undefined ? current.fontFamily : parseUiFontFamily(input.fontFamily),
    advancedEnabled: input.advancedEnabled === undefined
      ? current.advancedEnabled
      : parseAppearanceBoolean(input.advancedEnabled, "ADVANCED_APPEARANCE"),
    customCss: input.customCss === undefined
      ? current.customCss
      : parseAppearanceFragment(input.customCss, "CUSTOM_CSS"),
    headHtml: input.headHtml === undefined
      ? current.headHtml
      : parseAppearanceFragment(input.headHtml, "HEAD_HTML"),
    bodyEndHtml: input.bodyEndHtml === undefined
      ? current.bodyEndHtml
      : parseAppearanceFragment(input.bodyEndHtml, "BODY_END_HTML"),
    customJs: input.customJs === undefined
      ? current.customJs
      : parseAppearanceFragment(input.customJs, "CUSTOM_JAVASCRIPT"),
    customJsEnabled: input.customJsEnabled === undefined
      ? current.customJsEnabled
      : parseAppearanceBoolean(input.customJsEnabled, "JAVASCRIPT"),
  }

  const totalBytes = [next.customCss, next.headHtml, next.bodyEndHtml, next.customJs]
    .reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0)
  if (totalBytes > MAX_APPEARANCE_TOTAL_BYTES) {
    throw new Error("ADVANCED_APPEARANCE_TOTAL_TOO_LARGE")
  }

  await setConfigValues({
    [CONFIG_KEYS.UI_FONT_FAMILY]: next.fontFamily,
    [CONFIG_KEYS.APPEARANCE_ADVANCED_ENABLED]: String(next.advancedEnabled),
    [CONFIG_KEYS.APPEARANCE_CUSTOM_CSS]: next.customCss,
    [CONFIG_KEYS.APPEARANCE_HEAD_HTML]: next.headHtml,
    [CONFIG_KEYS.APPEARANCE_BODY_END_HTML]: next.bodyEndHtml,
    [CONFIG_KEYS.APPEARANCE_CUSTOM_JS]: next.customJs,
    [CONFIG_KEYS.APPEARANCE_CUSTOM_JS_ENABLED]: String(next.customJsEnabled),
  })
  return next
}
