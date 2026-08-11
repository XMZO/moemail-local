import assert from "node:assert/strict"
import {
  AuthRateLimiter,
  AuthWorkloadOverloadedError,
  ScryptConcurrencyGate,
  authRateLimitOptionsFrom,
  authRateLimitHeaders,
  getAuthClientAddress,
} from "../../app/lib/auth-abuse-guard"
import { createDefaultConfig } from "../../app/lib/config/schema"

const baseOptions = {
  windowMs: 10_000,
  loginClientLimit: 2,
  loginGlobalLimit: 3,
  registerClientLimit: 2,
  registerGlobalLimit: 3,
  maxClientEntries: 10,
  trustProxyHeaders: true,
}

let now = 1_000
const limiter = new AuthRateLimiter(baseOptions, () => now)
const firstClient = new Headers({
  "X-MoeMail-Client-IP": "203.0.113.9",
  "CF-Connecting-IP": "203.0.113.10",
  "X-Real-IP": "203.0.113.11",
  "X-Forwarded-For": "203.0.113.12, 10.0.0.1",
})
assert.equal(getAuthClientAddress(firstClient, true), "203.0.113.9")
assert.equal(limiter.consume("login", firstClient).allowed, true)
assert.equal(limiter.consume("login", firstClient).allowed, true)
const clientDenied = limiter.consume("login", firstClient)
assert.equal(clientDenied.allowed, false)
assert.equal(clientDenied.scope, "client")
assert.equal(clientDenied.retryAfterSeconds, 9)
assert.equal(authRateLimitHeaders(clientDenied).get("Retry-After"), "9")

const secondClient = new Headers({ "X-Real-IP": "203.0.113.20" })
assert.equal(limiter.consume("login", secondClient).allowed, true)
const globalDenied = limiter.consume(
  "login",
  new Headers({ "X-Forwarded-For": "203.0.113.30" }),
)
assert.equal(globalDenied.allowed, false)
assert.equal(globalDenied.scope, "global")

now = 10_001
assert.equal(limiter.consume("login", firstClient).allowed, true)

const separateActions = new AuthRateLimiter({
  ...baseOptions,
  loginClientLimit: 1,
  registerClientLimit: 1,
  loginGlobalLimit: 10,
  registerGlobalLimit: 10,
})
assert.equal(separateActions.consume("login", firstClient).allowed, true)
assert.equal(separateActions.consume("register", firstClient).allowed, true)
assert.equal(separateActions.consume("login", firstClient).allowed, false)
assert.equal(separateActions.consume("register", firstClient).allowed, false)

const untrustedLimiter = new AuthRateLimiter({
  ...baseOptions,
  loginClientLimit: 1,
  loginGlobalLimit: 10,
  trustProxyHeaders: false,
})
assert.equal(untrustedLimiter.consume(
  "login",
  new Headers({ "X-Forwarded-For": "198.51.100.1", "X-User-Id": "one" }),
).allowed, true)
const spoofedClientDenied = untrustedLimiter.consume(
  "login",
  new Headers({ "X-Forwarded-For": "198.51.100.2", "X-User-Id": "two" }),
)
assert.equal(spoofedClientDenied.allowed, false)
assert.equal(spoofedClientDenied.scope, "client")

const boundedLimiter = new AuthRateLimiter({
  ...baseOptions,
  loginClientLimit: 10,
  loginGlobalLimit: 10,
  maxClientEntries: 2,
})
assert.equal(boundedLimiter.consume(
  "login",
  new Headers({ "CF-Connecting-IP": "192.0.2.1" }),
).allowed, true)
assert.equal(boundedLimiter.consume(
  "login",
  new Headers({ "CF-Connecting-IP": "192.0.2.2" }),
).allowed, true)
const storageDenied = boundedLimiter.consume(
  "login",
  new Headers({ "CF-Connecting-IP": "192.0.2.3" }),
)
assert.equal(storageDenied.allowed, false)
assert.equal(storageDenied.scope, "storage")

const defaultConfig = createDefaultConfig()
assert.equal(authRateLimitOptionsFrom(defaultConfig).loginGlobalLimit, 300)
assert.equal(defaultConfig.auth.rateLimit.scryptMaxConcurrency, 2)

const gate = new ScryptConcurrencyGate(2)
const releases: Array<() => void> = []
const startBlockingWork = () => gate.run(() => new Promise<void>((resolve) => {
  releases.push(resolve)
}))
const firstWork = startBlockingWork()
const secondWork = startBlockingWork()
await assert.rejects(
  gate.run(async () => undefined),
  AuthWorkloadOverloadedError,
)
releases.forEach((release) => release())
await Promise.all([firstWork, secondWork])
assert.equal(await gate.run(async () => "available"), "available")

console.log(JSON.stringify({
  fixedWindow: true,
  perClientLimit: true,
  processGlobalLimit: true,
  boundedClientMap: true,
  proxyHeadersOptIn: true,
  ignoresUserIdentityHeaders: true,
  scryptConcurrencyFastFail: true,
}, null, 2))
