import assert from "node:assert/strict"
import worker from "../../workers/email-receiver"

function emailMessage(options: { rawSize?: number; onReject?: (reason: string) => void } = {}): ForwardableEmailMessage {
  const raw = new TextEncoder().encode(
    "From: sender@example.com\r\nTo: inbox@example.com\r\nSubject: probe\r\n\r\nhello\r\n",
  )

  return {
    from: "sender@example.com",
    to: "inbox@example.com",
    rawSize: options.rawSize ?? raw.byteLength,
    raw: new ReadableStream({
      start(controller) {
        controller.enqueue(raw)
        controller.close()
      },
    }),
    headers: new Headers(),
    setReject(reason) {
      if (options.onReject) options.onReject(reason)
      else throw new Error("UNEXPECTED_TEST_REJECTION")
    },
    forward() {
      throw new Error("UNEXPECTED_FORWARD_CALL")
    },
    reply() {
      throw new Error("UNEXPECTED_REPLY_CALL")
    },
  } as ForwardableEmailMessage
}

const env = {
  EMAIL_INGEST_URL: "https://mail.example.com/api/internal/email",
  EMAIL_INGEST_SECRET: "test-ingest-secret",
}

const originalFetch = globalThis.fetch
const originalLog = console.log
const originalError = console.error

function bufferedEmailObject(key: string) {
  const bytes = new TextEncoder().encode(
    "From: sender@example.com\r\nTo: inbox@example.com\r\nSubject: probe\r\n\r\nhello\r\n",
  )
  return {
    key,
    size: bytes.byteLength,
    customMetadata: {
      envelopeFrom: "sender@example.com",
      envelopeTo: "inbox@example.com",
    },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
  } as unknown as R2ObjectBody
}

function queueFixture(key: string) {
  let acknowledged = false
  let retryDelay: number | undefined
  const deleted: string[] = []
  const written: string[] = []
  const bucket = {
    get: async (requestedKey: string) => requestedKey === key ? bufferedEmailObject(key) : null,
    put: async (writtenKey: string) => { written.push(writtenKey); return {} },
    delete: async (deletedKey: string) => { deleted.push(deletedKey) },
  } as unknown as R2Bucket
  const message = {
    id: "queue-message",
    timestamp: new Date(),
    body: { key },
    attempts: 1,
    ack() { acknowledged = true },
    retry(options?: { delaySeconds?: number }) { retryDelay = options?.delaySeconds },
  }
  const batch = { queue: "email-delivery", messages: [message] } as unknown as MessageBatch<{ key: string }>
  return {
    bucket,
    batch,
    state: () => ({ acknowledged, retryDelay, deleted: [...deleted], written: [...written] }),
  }
}

try {
  let observedRedirect: RequestRedirect | undefined
  globalThis.fetch = (async (_input, init) => {
    observedRedirect = init?.redirect
    return new Response(JSON.stringify({ status: "created" }), { status: 201 })
  }) as typeof fetch
  console.log = () => undefined
  console.error = () => undefined

  await worker.email(emailMessage(), env)
  assert.equal(observedRedirect, "manual", "Email Worker must use a redirect mode supported at the edge")

  let rejectionReason = ""
  await worker.email(emailMessage({
    rawSize: 25 * 1024 * 1024 + 1,
    onReject: reason => { rejectionReason = reason },
  }), env)
  assert.equal(rejectionReason, "MESSAGE_TOO_LARGE", "SMTP rejection text must remain a locale-neutral protocol code")

  globalThis.fetch = (async (_input, init) => {
    observedRedirect = init?.redirect
    return new Response(null, {
      status: 302,
      headers: { Location: "https://redirect.example.com/api/internal/email" },
    })
  }) as typeof fetch

  await assert.rejects(
    worker.email(emailMessage(), env),
    /EMAIL_INGEST_HTTP_302/,
    "Email Worker must not follow redirects away from the configured ingest origin",
  )
  assert.equal(observedRedirect, "manual")

  let quotaRejection = ""
  globalThis.fetch = (async () => Response.json(
    {
      status: "rejected",
      reason: "RECEIVE_TOTAL_QUOTA_EXCEEDED",
      code: "RECEIVE_TOTAL_QUOTA_EXCEEDED",
    },
    { status: 429 },
  )) as typeof fetch
  await worker.email(emailMessage({
    onReject: reason => { quotaRejection = reason },
  }), env)
  assert.equal(quotaRejection, "RECEIVE_TOTAL_QUOTA_EXCEEDED")

  const rollingQuota = queueFixture("pending/rolling.eml")
  await worker.queue(rollingQuota.batch, {
    ...env,
    EMAIL_DELIVERY_MODE: "queue",
    EMAIL_BUFFER: rollingQuota.bucket,
  })
  assert.deepEqual(rollingQuota.state(), {
    acknowledged: false,
    retryDelay: 30,
    deleted: [],
    written: [],
  }, "rolling quota exhaustion must stay retryable in durable delivery mode")

  globalThis.fetch = (async () => Response.json(
    {
      status: "rejected",
      reason: "RECEIVE_MAILBOX_LIFETIME_QUOTA_EXCEEDED",
      code: "RECEIVE_MAILBOX_LIFETIME_QUOTA_EXCEEDED",
    },
    { status: 429 },
  )) as typeof fetch
  const lifetimeQuota = queueFixture("pending/lifetime.eml")
  await worker.queue(lifetimeQuota.batch, {
    ...env,
    EMAIL_DELIVERY_MODE: "queue",
    EMAIL_BUFFER: lifetimeQuota.bucket,
  })
  assert.deepEqual(lifetimeQuota.state(), {
    acknowledged: true,
    retryDelay: undefined,
    deleted: ["pending/lifetime.eml"],
    written: ["failed/lifetime.eml"],
  }, "lifetime quota exhaustion must move directly to the durable failed prefix")

  globalThis.fetch = (async () => Response.json(
    { error: "EMAIL_STORE_FAILED", code: "EMAIL_STORE_FAILED" },
    { status: 503 },
  )) as typeof fetch
  await assert.rejects(
    worker.email(emailMessage(), env),
    /EMAIL_INGEST_HTTP_503/,
    "Transient ingest failures must remain retryable",
  )
} finally {
  globalThis.fetch = originalFetch
  console.log = originalLog
  console.error = originalError
}

console.log(JSON.stringify({
  supportedRedirectMode: true,
  redirectsFailClosed: true,
  rejectionUsesProtocolCode: true,
  directQuotaRejectionUsesExactCode: true,
  rollingQuotaRemainsRetryable: true,
  lifetimeQuotaMovesToFailed: true,
  transientServerFailureRemainsRetryable: true,
}))
