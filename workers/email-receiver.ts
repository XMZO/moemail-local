const MAX_RAW_EMAIL_SIZE = 25 * 1024 * 1024
const INGEST_TIMEOUT = 75_000

interface EmailReceiverEnv {
  EMAIL_INGEST_URL: string
  EMAIL_INGEST_SECRET: string
  EMAIL_DELIVERY_MODE?: "direct" | "queue"
  EMAIL_MAX_DELIVERY_ATTEMPTS?: string
  EMAIL_BUFFER?: R2Bucket
  EMAIL_DELIVERY_QUEUE?: Queue<BufferedEmail>
}

interface BufferedEmail {
  key: string
}

class IngestRejection extends Error {
  constructor(
    readonly reason: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(reason)
    this.name = "IngestRejection"
  }
}

const INGEST_REJECTION_STATUSES = new Set([400, 401, 403, 404, 409, 413, 415, 422, 429])
const PROTOCOL_CODE_PATTERN = /^(?:[A-Z][A-Z0-9_]*|[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*)$/u

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value || "", 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function getIngestUrl(value: string) {
  const url = new URL(value)

  if (url.protocol !== "https:") {
    throw new Error("EMAIL_INGEST_URL_HTTPS_REQUIRED")
  }

  return url.toString()
}

const worker = {
  async email(message: ForwardableEmailMessage, env: EmailReceiverEnv): Promise<void> {
    if (!env.EMAIL_INGEST_URL || !env.EMAIL_INGEST_SECRET) {
      throw new Error("EMAIL_INGEST_NOT_CONFIGURED")
    }

    if (message.rawSize > MAX_RAW_EMAIL_SIZE) {
      message.setReject("MESSAGE_TOO_LARGE")
      return
    }

    if (env.EMAIL_DELIVERY_MODE !== "queue") {
      try {
        await forwardEmail(env, message.raw, {
          envelopeFrom: message.from,
          envelopeTo: message.to,
          rawSize: message.rawSize,
        })
      } catch (error) {
        if (error instanceof IngestRejection) {
          message.setReject(error.reason)
          return
        }
        throw error
      }
      return
    }

    if (!env.EMAIL_BUFFER || !env.EMAIL_DELIVERY_QUEUE) {
      throw new Error("EMAIL_QUEUE_BINDINGS_REQUIRED")
    }

    const key = `pending/${new Date().toISOString().slice(0, 10)}/${Date.now()}-${crypto.randomUUID()}.eml`
    await env.EMAIL_BUFFER.put(key, message.raw, {
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: {
        envelopeFrom: message.from,
        envelopeTo: message.to,
        rawSize: String(message.rawSize),
      },
    })
    await env.EMAIL_DELIVERY_QUEUE.send({ key })

    console.log("email.buffered", {
      key,
      recipient: message.to,
      rawSize: message.rawSize,
    })
  },

  async queue(batch: MessageBatch<BufferedEmail>, env: EmailReceiverEnv): Promise<void> {
    if (!env.EMAIL_BUFFER) {
      throw new Error("EMAIL_BUFFER_BINDING_REQUIRED")
    }

    for (const queuedMessage of batch.messages) {
      try {
        const object = await env.EMAIL_BUFFER.get(queuedMessage.body.key)
        if (!object) {
          queuedMessage.ack()
          continue
        }

        const metadata = object.customMetadata || {}
        if (!metadata.envelopeFrom || !metadata.envelopeTo) {
          throw new Error("BUFFERED_EMAIL_METADATA_MISSING")
        }

        await forwardEmail(env, object.body, {
          envelopeFrom: metadata.envelopeFrom,
          envelopeTo: metadata.envelopeTo,
          rawSize: object.size,
        })
        await env.EMAIL_BUFFER.delete(object.key)
        queuedMessage.ack()
      } catch (error) {
        console.error("email.queue_delivery_failed", {
          key: queuedMessage.body.key,
          attempt: queuedMessage.attempts,
          error: error instanceof Error ? error.message : String(error),
        })
        const maximumAttempts = positiveInteger(env.EMAIL_MAX_DELIVERY_ATTEMPTS, 12)
        if ((error instanceof IngestRejection && !error.retryable) || queuedMessage.attempts >= maximumAttempts) {
          await moveToFailed(env.EMAIL_BUFFER, queuedMessage.body.key, error)
          queuedMessage.ack()
          continue
        }
        queuedMessage.retry({ delaySeconds: Math.min(300, 15 * 2 ** queuedMessage.attempts) })
      }
    }
  },

  async scheduled(_controller: ScheduledController, env: EmailReceiverEnv): Promise<void> {
    if (env.EMAIL_DELIVERY_MODE !== "queue" || !env.EMAIL_BUFFER || !env.EMAIL_DELIVERY_QUEUE) {
      return
    }

    const failed = await env.EMAIL_BUFFER.list({ prefix: "failed/", limit: 10 })
    if (failed.objects.length > 0) {
      console.error("email.dead_letter_attention_required", {
        countAtLeast: failed.objects.length,
        keys: failed.objects.map(object => object.key),
      })
    }
    let cursor: string | undefined
    let requeued = 0
    do {
      const remaining = 2_000 - requeued
      if (remaining <= 0) break
      const pending = await env.EMAIL_BUFFER.list({
        prefix: "pending/",
        limit: Math.min(500, remaining),
        ...(cursor ? { cursor } : {}),
      })
      for (let offset = 0; offset < pending.objects.length; offset += 100) {
        await env.EMAIL_DELIVERY_QUEUE.sendBatch(
          pending.objects
            .slice(offset, offset + 100)
            .map(object => ({ body: { key: object.key } })),
        )
      }
      requeued += pending.objects.length
      cursor = pending.truncated ? pending.cursor : undefined
    } while (cursor && requeued < 2_000)

    if (requeued > 0) console.log("email.buffer_requeued", { count: requeued })
  },
}

async function moveToFailed(buffer: R2Bucket, key: string, error: unknown) {
  const object = await buffer.get(key)
  if (!object) return
  const failedKey = object.key.replace(/^pending\//, "failed/")
  await buffer.put(failedKey, object.body, {
    httpMetadata: { contentType: "message/rfc822" },
    customMetadata: {
      ...object.customMetadata,
      failedAt: new Date().toISOString(),
      failure: error instanceof Error
        ? error.message.slice(0, 512)
        : String(error).slice(0, 512),
    },
  })
  await buffer.delete(object.key)
}

async function rejectionReason(response: Response) {
  try {
    const body = await response.clone().json() as { code?: unknown; reason?: unknown }
    for (const value of [body.code, body.reason]) {
      if (typeof value === "string" && PROTOCOL_CODE_PATTERN.test(value)) return value
    }
  } catch {
    // A permanent HTTP status remains authoritative even without a JSON body.
  }
  return `EMAIL_INGEST_HTTP_${response.status}`
}

async function forwardEmail(
  env: EmailReceiverEnv,
  body: ReadableStream,
  envelope: { envelopeFrom: string; envelopeTo: string; rawSize: number },
) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), INGEST_TIMEOUT)

  try {
    const response = await fetch(getIngestUrl(env.EMAIL_INGEST_URL), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.EMAIL_INGEST_SECRET}`,
        "Content-Type": "message/rfc822",
        "X-MoeMail-Envelope-From": envelope.envelopeFrom,
        "X-MoeMail-Envelope-To": envelope.envelopeTo,
        "X-MoeMail-Raw-Size": String(envelope.rawSize),
      },
      body,
      // Cloudflare Workers implements only "follow" and "manual". Keep
      // redirects fail-closed by inspecting response.ok below instead of
      // following them to a potentially different origin.
      redirect: "manual",
      signal: controller.signal,
    })

    if (!response.ok) {
      if (INGEST_REJECTION_STATUSES.has(response.status)) {
        const reason = await rejectionReason(response)
        const retryable = response.status === 429
          && !reason.endsWith("_MAILBOX_LIFETIME_QUOTA_EXCEEDED")
        throw new IngestRejection(reason, response.status, retryable)
      }
      throw new Error(`EMAIL_INGEST_HTTP_${response.status}`)
    }

    console.log("email.ingestion_completed", {
      recipient: envelope.envelopeTo,
      rawSize: envelope.rawSize,
      status: response.status,
    })
  } finally {
    clearTimeout(timeoutId)
  }
}

export default worker
