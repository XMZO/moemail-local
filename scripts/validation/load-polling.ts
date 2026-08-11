import { existsSync, statSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value || "", 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function percentile(sorted: number[], fraction: number) {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

function targetProcessMetrics() {
  const pid = process.env.LOAD_TEST_TARGET_PID?.trim()
  if (!pid || process.platform === "win32") return undefined
  const result = spawnSync("ps", ["-p", pid, "-o", "rss=,pcpu="], { encoding: "utf8" })
  if (result.status !== 0) return undefined
  const [rssKiB, cpuPercent] = result.stdout.trim().split(/\s+/).map(Number)
  return { rssKiB, cpuPercent }
}

const url = process.env.LOAD_TEST_URL?.trim()
if (!url) throw new Error("LOAD_TEST_URL is required")

const concurrency = positiveInteger(process.env.LOAD_TEST_CONCURRENCY, 50)
const requestsPerClient = positiveInteger(process.env.LOAD_TEST_REQUESTS_PER_CLIENT, 3)
const headers: Record<string, string> = {}
if (process.env.LOAD_TEST_AUTHORIZATION) headers.Authorization = process.env.LOAD_TEST_AUTHORIZATION
if (process.env.LOAD_TEST_COOKIE) headers.Cookie = process.env.LOAD_TEST_COOKIE
if (process.env.LOAD_TEST_API_KEY) headers["X-API-Key"] = process.env.LOAD_TEST_API_KEY

const latencies: number[] = []
let errors = 0
let busyErrors = 0
let responseBytes = 0
const processBefore = targetProcessMetrics()
const startedAt = performance.now()

await Promise.all(Array.from({ length: concurrency }, async () => {
  for (let requestIndex = 0; requestIndex < requestsPerClient; requestIndex += 1) {
    const requestStartedAt = performance.now()
    try {
      const response = await fetch(url, {
        headers,
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      })
      const body = await response.arrayBuffer()
      responseBytes += body.byteLength
      latencies.push(performance.now() - requestStartedAt)
      if (!response.ok) {
        errors += 1
        if (Buffer.from(body).toString("utf8").includes("database is locked")) busyErrors += 1
      }
    } catch (error) {
      errors += 1
      latencies.push(performance.now() - requestStartedAt)
      if (error instanceof Error && error.message.includes("database is locked")) busyErrors += 1
    }
  }
}))

const durationMs = performance.now() - startedAt
latencies.sort((left, right) => left - right)
const sqlitePath = resolve(process.cwd(), process.env.SQLITE_PATH?.trim() || "data/moemail.db")
const walPath = `${sqlitePath}-wal`
const processAfter = targetProcessMetrics()
const result = {
  event: "validation.load.complete",
  url,
  concurrency,
  requests: concurrency * requestsPerClient,
  durationMs,
  requestsPerSecond: latencies.length / (durationMs / 1_000),
  latencyMs: {
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
  },
  errors,
  sqliteBusyErrors: busyErrors,
  responseBytes,
  responseKiBPerRequest: responseBytes / Math.max(1, latencies.length) / 1024,
  bandwidthMiBPerSecond: responseBytes / 1024 / 1024 / (durationMs / 1_000),
  sqliteWalBytes: existsSync(walPath) ? statSync(walPath).size : undefined,
  processBefore,
  processAfter,
}

console.log(JSON.stringify(result))
if (errors > 0) process.exitCode = 1
