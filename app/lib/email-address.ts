const LOCAL_PART_PATTERN = /^[a-z0-9._+-]+$/
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export function normalizeMailboxLocalPart(value: unknown) {
  if (typeof value !== "string") return null

  const normalized = value.trim().toLowerCase()
  if (
    normalized.length < 1
    || normalized.length > 64
    || !LOCAL_PART_PATTERN.test(normalized)
    || normalized.startsWith(".")
    || normalized.endsWith(".")
    || normalized.includes("..")
  ) {
    return null
  }

  return normalized
}

/**
 * Accepts the common paste mistake `local@domain` in a local-part field while
 * keeping strict address validation everywhere else.
 */
export function normalizeMailboxCreationName(value: unknown) {
  if (typeof value !== "string") return null
  return normalizeMailboxLocalPart(value.split("@", 1)[0])
}

export function normalizeMailboxDomain(value: unknown) {
  if (typeof value !== "string") return null

  const normalized = value.trim().toLowerCase()
  if (normalized.length < 1 || normalized.length > 253) return null

  const labels = normalized.split(".")
  if (labels.some(label => !DOMAIN_LABEL_PATTERN.test(label))) return null

  return normalized
}

export function normalizeMailboxAddress(value: unknown) {
  if (typeof value !== "string" || value !== value.trim()) return null

  const separator = value.indexOf("@")
  if (separator < 1 || separator !== value.lastIndexOf("@")) return null

  const localPart = normalizeMailboxLocalPart(value.slice(0, separator))
  const domain = normalizeMailboxDomain(value.slice(separator + 1))
  if (!localPart || !domain) return null

  const normalized = `${localPart}@${domain}`
  return normalized.length <= 254 ? normalized : null
}
