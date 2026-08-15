export interface ApiErrorPayload {
  error?: unknown
  code?: unknown
}

export const USER_BANNED_EVENT = "moemail:user-banned"

function apiErrorCode(body: ApiErrorPayload, fallback: string) {
  const code = typeof body.code === "string"
    ? body.code
    : typeof body.error === "string" ? body.error : ""
  return /^[A-Z][A-Z0-9_]*$/u.test(code) ? code : fallback
}

function announceBannedSession(code: string) {
  if (code === "USER_BANNED" && typeof window !== "undefined") {
    window.dispatchEvent(new Event(USER_BANNED_EVENT))
  }
}

export async function readApiErrorCode(response: Response, fallback: string) {
  try {
    const body = await response.json() as ApiErrorPayload
    const code = apiErrorCode(body, fallback)
    announceBannedSession(code)
    return code
  } catch {
    return fallback
  }
}

/**
 * Inspect a cloned error response without consuming the body needed by its
 * original caller. This lets the global session guard react to any protected
 * API, including older call sites that do not use readApiErrorCode yet.
 */
export async function announceBannedApiResponse(response: Response) {
  if (response.status !== 403) return false
  try {
    const body = await response.clone().json() as ApiErrorPayload
    const code = apiErrorCode(body, "")
    announceBannedSession(code)
    return code === "USER_BANNED"
  } catch {
    return false
  }
}
