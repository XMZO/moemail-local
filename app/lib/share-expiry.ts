export const SHARE_EXPIRY_MAX_MS = 10 * 365 * 24 * 60 * 60 * 1_000
export const SHARE_EXPIRY_MIN_MS = 60 * 1_000

export function parseShareExpiry(value: unknown): number | null {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
    || value > SHARE_EXPIRY_MAX_MS
    || (value > 0 && value < SHARE_EXPIRY_MIN_MS)
  ) return null
  return value
}

export function shareExpiresAt(expiresIn: number, now = Date.now()) {
  return expiresIn === 0 ? null : new Date(now + expiresIn)
}
