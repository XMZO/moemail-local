import { isIP } from "node:net"
import { getConfig } from "./config/runtime"
import type { AppConfig } from "./config/schema"

export type AuthRateLimitAction = "login" | "register"

export type AuthRateLimitOptions = {
  windowMs: number
  loginClientLimit: number
  loginGlobalLimit: number
  registerClientLimit: number
  registerGlobalLimit: number
  maxClientEntries: number
  trustProxyHeaders: boolean
}

export type AuthRateLimitDecision = {
  allowed: boolean
  limit: number
  remaining: number
  resetAt: number
  retryAfterSeconds: number
  scope: "client" | "global" | "storage"
}

export function authRateLimitOptionsFrom(config: AppConfig): AuthRateLimitOptions {
  const { rateLimit } = config.auth
  return {
    windowMs: rateLimit.windowSeconds * 1_000,
    loginClientLimit: rateLimit.loginPerClient,
    loginGlobalLimit: rateLimit.loginGlobal,
    registerClientLimit: rateLimit.registerPerClient,
    registerGlobalLimit: rateLimit.registerGlobal,
    maxClientEntries: rateLimit.maxClients,
    trustProxyHeaders: config.server.trustProxyHeaders,
  }
}

/** 每次调用都读取当前配置，修改配置文件后立即生效。 */
export function getAuthRateLimitOptions() {
  return authRateLimitOptionsFrom(getConfig())
}

function proxyClientAddress(headers: Headers) {
  const candidates = [
    headers.get("x-moemail-client-ip"),
    headers.get("cf-connecting-ip"),
    headers.get("x-real-ip"),
    headers.get("x-forwarded-for")?.split(",", 1)[0],
  ]

  for (const candidate of candidates) {
    const address = candidate?.trim()
    if (address && isIP(address)) return address.toLowerCase()
  }
  return "unknown-client"
}

export function getAuthClientAddress(headers: Headers, trustProxyHeaders: boolean) {
  if (!trustProxyHeaders) return "untrusted-proxy-headers"
  return proxyClientAddress(headers)
}

export class AuthRateLimiter {
  private windowStart = -1
  private readonly globalCounts: Record<AuthRateLimitAction, number> = {
    login: 0,
    register: 0,
  }
  private readonly clientCounts = new Map<string, number>()

  constructor(
    private readonly source: AuthRateLimitOptions | (() => AuthRateLimitOptions),
    private readonly now: () => number = Date.now,
  ) {}

  consume(action: AuthRateLimitAction, headers: Headers): AuthRateLimitDecision {
    const options = typeof this.source === "function" ? this.source() : this.source
    const now = this.now()
    const windowStart = Math.floor(now / options.windowMs) * options.windowMs
    if (windowStart !== this.windowStart) {
      this.windowStart = windowStart
      this.globalCounts.login = 0
      this.globalCounts.register = 0
      this.clientCounts.clear()
    }

    const resetAt = windowStart + options.windowMs
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000))
    const globalLimit = action === "login"
      ? options.loginGlobalLimit
      : options.registerGlobalLimit
    const clientLimit = action === "login"
      ? options.loginClientLimit
      : options.registerClientLimit

    if (this.globalCounts[action] >= globalLimit) {
      return {
        allowed: false,
        limit: globalLimit,
        remaining: 0,
        resetAt,
        retryAfterSeconds,
        scope: "global",
      }
    }

    const clientAddress = getAuthClientAddress(headers, options.trustProxyHeaders)
    const clientKey = `${action}:${clientAddress}`
    const clientCount = this.clientCounts.get(clientKey) ?? 0
    if (clientCount >= clientLimit) {
      return {
        allowed: false,
        limit: clientLimit,
        remaining: 0,
        resetAt,
        retryAfterSeconds,
        scope: "client",
      }
    }

    if (!this.clientCounts.has(clientKey) && this.clientCounts.size >= options.maxClientEntries) {
      return {
        allowed: false,
        limit: options.maxClientEntries,
        remaining: 0,
        resetAt,
        retryAfterSeconds,
        scope: "storage",
      }
    }

    this.globalCounts[action] += 1
    this.clientCounts.set(clientKey, clientCount + 1)

    return {
      allowed: true,
      limit: clientLimit,
      remaining: clientLimit - clientCount - 1,
      resetAt,
      retryAfterSeconds: 0,
      scope: "client",
    }
  }
}

let rateLimiter: AuthRateLimiter | undefined

export function consumeAuthRateLimit(
  action: AuthRateLimitAction,
  headers: Headers,
) {
  rateLimiter ??= new AuthRateLimiter(getAuthRateLimitOptions)
  return rateLimiter.consume(action, headers)
}

export function authRateLimitHeaders(decision: AuthRateLimitDecision) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-RateLimit-Limit": decision.limit.toString(),
    "X-RateLimit-Remaining": decision.remaining.toString(),
    "X-RateLimit-Reset": Math.ceil(decision.resetAt / 1000).toString(),
  })
  if (!decision.allowed) {
    headers.set("Retry-After", decision.retryAfterSeconds.toString())
  }
  return headers
}

export class AuthWorkloadOverloadedError extends Error {
  readonly retryAfterSeconds = 1

  constructor() {
    super("Authentication password workload is temporarily at capacity")
    this.name = "AuthWorkloadOverloadedError"
  }
}

export class ScryptConcurrencyGate {
  private active = 0
  private maximum: number

  constructor(maximum: number) {
    this.maximum = ScryptConcurrencyGate.validate(maximum)
  }

  private static validate(maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new Error("Scrypt concurrency maximum must be a positive integer")
    }
    return maximum
  }

  setMaximum(maximum: number) {
    this.maximum = ScryptConcurrencyGate.validate(maximum)
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.maximum) {
      throw new AuthWorkloadOverloadedError()
    }

    this.active += 1
    try {
      return await work()
    } finally {
      this.active -= 1
    }
  }
}

export function getScryptConcurrency() {
  return getConfig().auth.rateLimit.scryptMaxConcurrency
}

let scryptGate: ScryptConcurrencyGate | undefined

export function withScryptCapacity<T>(work: () => Promise<T>) {
  const maximum = getScryptConcurrency()
  if (!scryptGate) scryptGate = new ScryptConcurrencyGate(maximum)
  else scryptGate.setMaximum(maximum)
  return scryptGate.run(work)
}
