export interface ApiErrorPayload {
  error?: unknown
  code?: unknown
}

export async function readApiErrorCode(response: Response, fallback: string) {
  try {
    const body = await response.json() as ApiErrorPayload
    const code = typeof body.code === "string"
      ? body.code
      : typeof body.error === "string" ? body.error : ""
    return /^[A-Z][A-Z0-9_]*$/u.test(code) ? code : fallback
  } catch {
    return fallback
  }
}
