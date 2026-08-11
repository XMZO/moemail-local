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

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value || "", 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function getIngestUrl(value: string) {
  const url = new URL(value)

  if (url.protocol !== "https:") {
    throw new Error("EMAIL_INGEST_URL must use HTTPS")
  }

  return url.toString()
}

const worker = {
  async email(message: ForwardableEmailMessage, env: EmailReceiverEnv): Promise<void> {
    if (!env.EMAIL_INGEST_URL || !env.EMAIL_INGEST_SECRET) {
      throw new Error("Email ingestion is not configured")
    }

    if (message.rawSize > MAX_RAW_EMAIL_SIZE) {
      message.setReject("Message too large")
      return
    }

    if (env.EMAIL_DELIVERY_MODE !== "queue") {
      await forwardEmail(env, message.raw, {
        envelopeFrom: message.from,
        envelopeTo: message.to,
        rawSize: message.rawSize,
      })
      return
    }

    if (!env.EMAIL_BUFFER || !env.EMAIL_DELIVERY_QUEUE) {
      throw new Error("Queue delivery requires EMAIL_BUFFER and EMAIL_DELIVERY_QUEUE bindings")
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

    console.log("Email buffered for delivery", {
      key,
      recipient: message.to,
      rawSize: message.rawSize,
    })
  },

  async queue(batch: MessageBatch<BufferedEmail>, env: EmailReceiverEnv): Promise<void> {
    if (!env.EMAIL_BUFFER) {
      throw new Error("Queue delivery requires the EMAIL_BUFFER binding")
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
          throw new Error(`Buffered email ${object.key} is missing envelope metadata`)
        }

        await forwardEmail(env, object.body, {
          envelopeFrom: metadata.envelopeFrom,
          envelopeTo: metadata.envelopeTo,
          rawSize: object.size,
        })
        await env.EMAIL_BUFFER.delete(object.key)
        queuedMessage.ack()
      } catch (error) {
        console.error("Queued email delivery failed", {
          key: queuedMessage.body.key,
          attempt: queuedMessage.attempts,
          error: error instanceof Error ? error.message : String(error),
        })
        const maximumAttempts = positiveInteger(env.EMAIL_MAX_DELIVERY_ATTEMPTS, 12)
        if (queuedMessage.attempts >= maximumAttempts) {
          const object = await env.EMAIL_BUFFER.get(queuedMessage.body.key)
          if (object) {
            const failedKey = object.key.replace(/^pending\//, "failed/")
            await env.EMAIL_BUFFER.put(failedKey, object.body, {
              httpMetadata: { contentType: "message/rfc822" },
              customMetadata: {
                ...object.customMetadata,
                failedAt: new Date().toISOString(),
                failure: error instanceof Error
                  ? error.message.slice(0, 512)
                  : String(error).slice(0, 512),
              },
            })
            await env.EMAIL_BUFFER.delete(object.key)
          }
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
      console.error("Email delivery dead-letter objects require attention", {
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

    if (requeued > 0) console.log("Re-enqueued buffered emails", { count: requeued })
  },
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
      throw new Error(`Email ingestion failed with HTTP ${response.status}`)
    }

    console.log("Email ingestion completed", {
      recipient: envelope.envelopeTo,
      rawSize: envelope.rawSize,
      status: response.status,
    })
  } finally {
    clearTimeout(timeoutId)
  }
}

export default worker
