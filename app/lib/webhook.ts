import { lookup } from "node:dns/promises"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { BlockList, isIP } from "node:net"
import { WEBHOOK_CONFIG } from "@/config"

export interface EmailMessage {
  emailId: string
  messageId: string
  fromAddress: string
  subject: string
  content: string
  html: string
  receivedAt: string
  toAddress: string
}

export interface WebhookPayload {
  event: typeof WEBHOOK_CONFIG.EVENTS[keyof typeof WEBHOOK_CONFIG.EVENTS]
  data: EmailMessage
}

const blockedAddresses = new BlockList()
const ipv4MappedAddresses = new BlockList()
ipv4MappedAddresses.addSubnet("::ffff:0:0", 96, "ipv6")

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4")
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6")
}

function normalizeHostname(hostname: string) {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase()
}

function parseWebhookUrl(value: string) {
  const url = new URL(value)

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Webhook URL must use HTTP or HTTPS")
  }
  if (url.username || url.password) {
    throw new Error("Webhook URL must not contain credentials")
  }

  const hostname = normalizeHostname(url.hostname)
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Webhook URL resolves to a non-public host")
  }

  return { url, hostname }
}

async function resolvePublicAddresses(hostname: string) {
  const literalFamily = isIP(hostname)
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname, { all: true, verbatim: true })

  if (addresses.length === 0) {
    throw new Error("Webhook host did not resolve")
  }

  for (const address of addresses) {
    const family = address.family === 6 ? "ipv6" : "ipv4"
    if (
      (family === "ipv6" && ipv4MappedAddresses.check(address.address, "ipv6")) ||
      blockedAddresses.check(address.address, family)
    ) {
      throw new Error("Webhook URL resolves to a non-public address")
    }
  }

  return addresses
}

export async function validateWebhookUrl(value: string) {
  const { url, hostname } = parseWebhookUrl(value)
  await resolvePublicAddresses(hostname)
  return url
}

async function sendWebhookRequest(url: URL, hostname: string, payload: WebhookPayload, attempt: number) {
  const addresses = await resolvePublicAddresses(hostname)
  const selectedAddress = addresses[attempt % addresses.length]
  const pinnedUrl = new URL(url)
  pinnedUrl.hostname = selectedAddress.family === 6
    ? `[${selectedAddress.address}]`
    : selectedAddress.address

  const body = JSON.stringify(payload.data)
  const headers = {
    Host: url.host,
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body)),
    "X-Webhook-Event": payload.event,
  }

  return new Promise<number>((resolve, reject) => {
    const handleResponse = (response: import("node:http").IncomingMessage) => {
      clearTimeout(timeoutId)
      const statusCode = response.statusCode ?? 0
      response.destroy()
      resolve(statusCode)
    }

    const request = url.protocol === "https:"
      ? httpsRequest(pinnedUrl, {
          method: "POST",
          headers,
          agent: false,
          servername: isIP(hostname) ? undefined : hostname,
        }, handleResponse)
      : httpRequest(pinnedUrl, {
          method: "POST",
          headers,
          agent: false,
        }, handleResponse)

    const timeoutId = setTimeout(() => {
      request.destroy(new Error("Webhook request timed out"))
    }, WEBHOOK_CONFIG.TIMEOUT)

    request.once("error", (error) => {
      clearTimeout(timeoutId)
      reject(error)
    })
    request.end(body)
  })
}

export async function callWebhook(urlValue: string, payload: WebhookPayload) {
  const { url, hostname } = parseWebhookUrl(urlValue)
  let lastError: Error | null = null

  for (let attempt = 0; attempt < WEBHOOK_CONFIG.MAX_RETRIES; attempt++) {
    try {
      const statusCode = await sendWebhookRequest(url, hostname, payload, attempt)
      if (statusCode >= 200 && statusCode < 300) {
        return true
      }

      lastError = new Error(`HTTP error! status: ${statusCode}`)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }

    if (attempt < WEBHOOK_CONFIG.MAX_RETRIES - 1) {
      await new Promise((resolve) => setTimeout(resolve, WEBHOOK_CONFIG.RETRY_DELAY))
    }
  }

  throw lastError ?? new Error("Webhook request failed")
}
