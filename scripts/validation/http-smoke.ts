export {}

const baseUrl = (process.env.VALIDATION_BASE_URL?.trim() || "http://127.0.0.1:3000").replace(/\/$/, "")

async function expectStatus(path: string, expected: number, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    ...init,
  })
  if (response.status !== expected) {
    throw new Error(`${path}: expected HTTP ${expected}, received ${response.status}`)
  }
  return response
}

await expectStatus("/api/internal/health", 200)
const home = await fetch(`${baseUrl}/`, { redirect: "manual", signal: AbortSignal.timeout(15_000) })
if (home.status < 200 || home.status >= 400) {
  throw new Error(`/: expected success or redirect, received HTTP ${home.status}`)
}

const raw = Buffer.from("From: smoke@example.com\r\nTo: nobody@example.com\r\n\r\nsmoke")
await expectStatus("/api/internal/email", 401, {
  method: "POST",
  headers: {
    Authorization: "Bearer deliberately-invalid",
    "Content-Type": "message/rfc822",
    "X-MoeMail-Envelope-From": "smoke@example.com",
    "X-MoeMail-Envelope-To": "nobody@example.com",
    "X-MoeMail-Raw-Size": String(raw.byteLength),
  },
  body: raw,
})

console.log(JSON.stringify({ event: "validation.http.ok", baseUrl }))
