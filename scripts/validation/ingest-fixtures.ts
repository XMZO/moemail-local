export {}

const baseUrl = (process.env.VALIDATION_BASE_URL?.trim() || "http://127.0.0.1:3000").replace(/\/$/, "")
const recipient = process.env.INGEST_TEST_RECIPIENT?.trim()
const secret = process.env.EMAIL_INGEST_SECRET?.trim()
const largeBytes = Number.parseInt(process.env.INGEST_TEST_LARGE_BYTES || "5242880", 10)

if (!recipient || !secret) {
  throw new Error("INGEST_TEST_RECIPIENT and EMAIL_INGEST_SECRET are required")
}
const testRecipient = recipient
const ingestSecret = secret

function email(headers: string[], body: string) {
  return Buffer.from([...headers, "MIME-Version: 1.0", "", body].join("\r\n"))
}

const marker = `${Date.now()}-${crypto.randomUUID()}`
const fixtures = [
  {
    name: "small-text",
    raw: email([
      "From: fixture@example.com",
      `To: ${testRecipient}`,
      `Subject: fixture-small-${marker}`,
      "Content-Type: text/plain; charset=utf-8",
    ], "small fixture"),
  },
  {
    name: "html-only",
    raw: email([
      "From: fixture@example.com",
      `To: ${testRecipient}`,
      `Subject: fixture-html-${marker}`,
      "Content-Type: text/html; charset=utf-8",
    ], `<strong>html-only-${marker}</strong>`),
  },
  {
    name: "no-subject-empty-body",
    raw: email([
      "From: fixture@example.com",
      `To: ${testRecipient}`,
      "Content-Type: text/plain; charset=utf-8",
    ], ""),
  },
  {
    name: "large-html",
    raw: email([
      "From: fixture@example.com",
      `To: ${testRecipient}`,
      `Subject: fixture-large-${marker}`,
      "Content-Type: text/html; charset=utf-8",
    ], `<html><body>${"x".repeat(Math.max(1, largeBytes))}</body></html>`),
  },
]

interface IngestOptions {
  contentType?: string
  declaredSize?: number
  envelopeTo?: string
}

async function ingest(raw: Buffer, options: IngestOptions = {}) {
  const response = await fetch(`${baseUrl}/api/internal/email`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ingestSecret}`,
      "Content-Type": options.contentType || "message/rfc822",
      "X-MoeMail-Envelope-From": "fixture@example.com",
      "X-MoeMail-Envelope-To": options.envelopeTo || testRecipient,
      "X-MoeMail-Raw-Size": String(options.declaredSize ?? raw.byteLength),
    },
    body: raw,
    signal: AbortSignal.timeout(90_000),
  })
  const data = await response.json() as {
    status?: string
    messageId?: string
    error?: string
    reason?: string
  }
  if (!response.ok) {
    throw new Error(`Ingestion failed with HTTP ${response.status}: ${data.error || "unknown error"}`)
  }
  return { httpStatus: response.status, ...data }
}

async function expectRejected(
  name: string,
  raw: Buffer,
  expectedStatus: number,
  expectedError: string,
  options: IngestOptions,
) {
  const response = await fetch(`${baseUrl}/api/internal/email`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ingestSecret}`,
      "Content-Type": options.contentType || "message/rfc822",
      "X-MoeMail-Envelope-From": "fixture@example.com",
      "X-MoeMail-Envelope-To": options.envelopeTo || testRecipient,
      "X-MoeMail-Raw-Size": String(options.declaredSize ?? raw.byteLength),
    },
    body: raw,
    signal: AbortSignal.timeout(90_000),
  })
  const data = await response.json() as { error?: string }
  if (response.status !== expectedStatus || data.error !== expectedError) {
    throw new Error(
      `${name}: expected HTTP ${expectedStatus} ${expectedError}, received HTTP ${response.status} ${data.error || "unknown"}`,
    )
  }
  return { name, httpStatus: response.status, error: data.error }
}

const results = []
for (const fixture of fixtures) {
  results.push({ name: fixture.name, bytes: fixture.raw.byteLength, result: await ingest(fixture.raw) })
}

const replay = await ingest(fixtures[0].raw)
if (replay.status !== "duplicate") {
  throw new Error(`Expected duplicate replay, received ${replay.status || "unknown"}`)
}

const unknownRecipient = await ingest(fixtures[0].raw, {
  envelopeTo: `missing-${marker}@invalid.example`,
})
if (unknownRecipient.status !== "ignored" || unknownRecipient.reason !== "unknown_recipient") {
  throw new Error(`Expected unknown recipient to be ignored, received ${unknownRecipient.status || "unknown"}`)
}

const rejected = [
  await expectRejected(
    "declared-size-mismatch",
    fixtures[0].raw,
    400,
    "Raw message size mismatch",
    { declaredSize: fixtures[0].raw.byteLength + 1 },
  ),
  await expectRejected(
    "oversized-declaration",
    fixtures[0].raw,
    413,
    "Message too large",
    { declaredSize: 25 * 1024 * 1024 + 1 },
  ),
  await expectRejected(
    "unsupported-content-type",
    fixtures[0].raw,
    415,
    "Unsupported media type",
    { contentType: "application/octet-stream" },
  ),
]

console.log(JSON.stringify({
  event: "validation.ingest.ok",
  recipient: testRecipient,
  results,
  replay,
  unknownRecipient,
  rejected,
}))
