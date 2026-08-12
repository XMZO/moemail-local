import { CONFIG_KEYS, getConfigValue, setConfigValues } from "./config-store"
import { DEFAULT_UI_FONT_FAMILY } from "./appearance-values"

export { DEFAULT_UI_FONT_FAMILY } from "./appearance-values"

export function parseUiFontFamily(value: unknown) {
  if (typeof value !== "string") throw new Error("字体族必须是字符串")
  const trimmed = value.trim()
  if (!trimmed) return DEFAULT_UI_FONT_FAMILY
  if (trimmed.length > 200) throw new Error("字体族最多 200 个字符")
  if (
    /[;{}<>\r\n\\]/.test(trimmed)
    || /(?:url|expression|image-set)\s*\(/i.test(trimmed)
  ) {
    throw new Error("字体族包含不安全的 CSS 内容")
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
