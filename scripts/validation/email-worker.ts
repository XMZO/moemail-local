import assert from "node:assert/strict"
import worker from "../../workers/email-receiver"

function emailMessage(): ForwardableEmailMessage {
  const raw = new TextEncoder().encode(
    "From: sender@example.com\r\nTo: inbox@example.com\r\nSubject: probe\r\n\r\nhello\r\n",
  )

  return {
    from: "sender@example.com",
    to: "inbox@example.com",
    rawSize: raw.byteLength,
    raw: new ReadableStream({
      start(controller) {
        controller.enqueue(raw)
        controller.close()
      },
    }),
    headers: new Headers(),
    setReject() {
      throw new Error("test message was unexpectedly rejected")
    },
    forward() {
      throw new Error("forward() is not used by this worker")
    },
    reply() {
      throw new Error("reply() is not used by this worker")
    },
  } as ForwardableEmailMessage
}

const env = {
  EMAIL_INGEST_URL: "https://mail.example.com/api/internal/email",
  EMAIL_INGEST_SECRET: "test-ingest-secret",
}

const originalFetch = globalThis.fetch
const originalLog = console.log

try {
  let observedRedirect: RequestRedirect | undefined
  globalThis.fetch = (async (_input, init) => {
    observedRedirect = init?.redirect
    return new Response(JSON.stringify({ status: "created" }), { status: 201 })
  }) as typeof fetch
  console.log = () => undefined

  await worker.email(emailMessage(), env)
  assert.equal(observedRedirect, "manual", "Email Worker must use a redirect mode supported at the edge")

  globalThis.fetch = (async (_input, init) => {
    observedRedirect = init?.redirect
    return new Response(null, {
      status: 302,
      headers: { Location: "https://redirect.example.com/api/internal/email" },
    })
  }) as typeof fetch

  await assert.rejects(
    worker.email(emailMessage(), env),
    /Email ingestion failed with HTTP 302/,
    "Email Worker must not follow redirects away from the configured ingest origin",
  )
  assert.equal(observedRedirect, "manual")
} finally {
  globalThis.fetch = originalFetch
  console.log = originalLog
}

console.log(JSON.stringify({ supportedRedirectMode: true, redirectsFailClosed: true }))
