import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { hostname } from "node:os"
import { dirname, join } from "node:path"
import {
  getConfig,
  getConfigStatus,
  getSetupRecoveryConfig,
  isSetupCompleted,
  mergeConfig,
  saveConfig,
} from "./config/runtime"
import { parseConfigDocument } from "./config/file"
import {
  parseConfig,
  type AppConfig,
  type ConfigIssue,
} from "./config/schema"
import {
  createInitialEmperor,
  listEmperorCredentials,
  probeDatabase,
  runMigrations,
} from "./database-setup"
import { checkDriverBinding } from "./db"
import { hashPassword, verifyPassword } from "./password"
import { authSchema } from "./validation"
import type { ApiErrorCode } from "./api-codes"
import {
  ensureSetupToken,
  generateSecret,
  removeSetupToken,
} from "./setup-token"
import { apiError } from "./api-response"

export {
  ensureSetupToken,
  generateSecret,
  getSetupTokenPath,
  removeSetupToken,
} from "./setup-token"

const SETUP_WINDOW_MS = 60_000
const SETUP_MAX_REQUESTS = 30
const SETUP_LOCK_STALE_MS = 60 * 60_000

let windowStart = 0
let windowCount = 0

type SetupGlobals = typeof globalThis & {
  __moemailSetupOperationActive?: boolean
}

const setupGlobals = globalThis as SetupGlobals

function setupTokenMatches(supplied: string, expected: string) {
  const suppliedDigest = createHash("sha256").update(supplied).digest()
  const expectedDigest = createHash("sha256").update(expected).digest()
  return timingSafeEqual(suppliedDigest, expectedDigest)
}

function isSameOriginRequest(request: Request) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false
  const origin = request.headers.get("origin")
  if (!origin) return true
  try {
    return new URL(origin).host === (request.headers.get("host") ?? new URL(request.url).host)
  } catch {
    return false
  }
}

/** 初始化接口在完成前是匿名可用的，这里做一个粗粒度的进程级限流。 */
export function consumeSetupBudget() {
  const now = Date.now()
  if (now - windowStart > SETUP_WINDOW_MS) {
    windowStart = now
    windowCount = 0
  }
  windowCount += 1
  return windowCount <= SETUP_MAX_REQUESTS
}

export function setupClosedResponse() {
  if (isSetupCompleted()) {
    return apiError("SETUP_ALREADY_COMPLETED", 409, {
      headers: { "Cache-Control": "no-store" },
    })
  }
  if (!consumeSetupBudget()) {
    return apiError("SETUP_RATE_LIMITED", 429, {
      headers: { "Cache-Control": "no-store" },
    })
  }
  return null
}

export function authorizeSetupRequest(
  request: Request,
  options: { consumeBudget?: boolean } = {},
) {
  if (isSetupCompleted()) {
    removeSetupToken({ log: false })
    return apiError("SETUP_ALREADY_COMPLETED", 409, {
      headers: { "Cache-Control": "no-store" },
    })
  }

  if (options.consumeBudget !== false && !consumeSetupBudget()) {
    return apiError("SETUP_RATE_LIMITED", 429, {
      headers: { "Cache-Control": "no-store" },
    })
  }

  if (!isSameOriginRequest(request)) {
    return apiError("SETUP_CROSS_SITE_FORBIDDEN", 403, {
      headers: { "Cache-Control": "no-store" },
    })
  }

  let expected: string
  try {
    expected = ensureSetupToken() ?? ""
  } catch (error) {
    console.error("setup.token_prepare_failed", error)
    return apiError("SETUP_TOKEN_UNAVAILABLE", 503, {
      headers: { "Cache-Control": "no-store" },
    })
  }

  const supplied = request.headers.get("x-moemail-setup-token") ?? ""
  if (!expected || !setupTokenMatches(supplied, expected)) {
    return apiError("SETUP_TOKEN_INVALID", 401, {
      headers: { "Cache-Control": "no-store" },
    })
  }

  return null
}

/** 数据库探测与最终初始化共享同一把进程内锁，避免并发抢占和末写覆盖。 */
export function acquireSetupOperation() {
  if (setupGlobals.__moemailSetupOperationActive) return null

  const lockPath = join(dirname(getConfigStatus().path), "setup-operation.lock")
  const nonce = randomBytes(16).toString("hex")
  const record = {
    nonce,
    pid: process.pid,
    hostname: hostname(),
    createdAt: new Date().toISOString(),
  }
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })

  let descriptor: number | undefined
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = openSync(lockPath, "wx", 0o600)
      writeFileSync(descriptor, JSON.stringify(record), "utf8")
      try {
        chmodSync(lockPath, 0o600)
      } catch {
        // Windows 与部分文件系统不支持 POSIX 权限位。
      }
      break
    } catch (error) {
      const createdLock = descriptor !== undefined
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor)
        } catch {}
        descriptor = undefined
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        if (createdLock) {
          try {
            rmSync(lockPath, { force: true })
          } catch {}
        }
        throw error
      }

      let removeStale = false
      let observedLockRaw = ""
      try {
        const stats = statSync(lockPath)
        let owner: { pid?: unknown; hostname?: unknown } = {}
        try {
          observedLockRaw = readFileSync(lockPath, "utf8")
          owner = JSON.parse(observedLockRaw) as typeof owner
        } catch {}

        let ownerAlive: boolean | null = null
        if (owner.hostname === hostname() && Number.isInteger(owner.pid)) {
          try {
            process.kill(owner.pid as number, 0)
            ownerAlive = true
          } catch (ownerError) {
            if ((ownerError as NodeJS.ErrnoException).code === "ESRCH") ownerAlive = false
          }
        }
        removeStale = ownerAlive === false
          || Date.now() - stats.mtimeMs > SETUP_LOCK_STALE_MS
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code === "ENOENT") continue
        throw lockError
      }

      if (!removeStale) return null
      try {
        // 锁所有者可能刚释放且另一进程已经拿到新锁；只删除我们检查过的
        // 那一份内容，避免误删新所有者的锁。
        if (readFileSync(lockPath, "utf8") !== observedLockRaw) continue
        rmSync(lockPath, { force: true })
      } catch (removeError) {
        if ((removeError as NodeJS.ErrnoException).code !== "ENOENT") throw removeError
      }
    }
  }

  if (descriptor === undefined) return null
  setupGlobals.__moemailSetupOperationActive = true
  const heartbeat = setInterval(() => {
    try {
      const current = JSON.parse(readFileSync(lockPath, "utf8")) as { nonce?: unknown }
      if (current.nonce === nonce) utimesSync(lockPath, new Date(), new Date())
    } catch {
      // release 或数据卷暂时不可用时无需让心跳异常终止初始化。
    }
  }, 60_000)
  heartbeat.unref?.()
  let released = false
  return () => {
    if (released) return
    released = true
    clearInterval(heartbeat)
    setupGlobals.__moemailSetupOperationActive = false
    try {
      closeSync(descriptor)
    } catch {}
    try {
      const current = JSON.parse(readFileSync(lockPath, "utf8")) as { nonce?: unknown }
      if (current.nonce === nonce) rmSync(lockPath, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(JSON.stringify({
          event: "setup.lock.release.failed",
          path: lockPath,
          message: error instanceof Error ? error.message : String(error),
        }))
      }
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 合并向导提交的片段，补齐随机密钥；不接受来自请求体的 setup 段。 */
export function buildCandidateConfig(patch: unknown, options: { completed: boolean }) {
  let current: AppConfig
  try {
    current = getConfig()
  } catch {
    current = getSetupRecoveryConfig()
  }
  if (!isPlainObject(patch)) {
    return {
      ok: false as const,
      issues: [{ path: "config", message: "OBJECT_REQUIRED" }],
    }
  }

  const sanitized = { ...patch }
  delete sanitized.setup
  delete sanitized.version

  const merged = mergeConfig(current, sanitized) as Record<string, unknown>
  const parsed = parseConfig(merged)
  if (!parsed.ok) return parsed

  const withSecrets = mergeConfig(parsed.config, {
    setup: {
      completed: options.completed,
      completedAt: options.completed
        ? current.setup.completedAt ?? new Date().toISOString()
        : null,
    },
    auth: {
      secret: parsed.config.auth.secret ?? generateSecret(),
      passwordPepper: parsed.config.auth.passwordPepper ?? generateSecret(),
    },
    email: {
      ingestSecret: parsed.config.email.ingestSecret ?? generateSecret(),
    },
  })

  return parseConfig(withSecrets)
}

export type SetupConfigPatchResult =
  | { ok: true; patch: unknown }
  | { ok: false; issues: ConfigIssue[] }

/** 高级 YAML 先合并，结构化表单后合并，因此明确填写的核心字段优先。 */
export function buildSetupConfigPatch(input: Record<string, unknown>): SetupConfigPatchResult {
  let advanced: unknown = {}
  if (input.advancedYaml !== undefined) {
    if (typeof input.advancedYaml !== "string") {
      return {
        ok: false,
        issues: [{ path: "advancedYaml", message: "YAML_STRING_REQUIRED" }],
      }
    }
    try {
      advanced = parseConfigDocument(input.advancedYaml)
    } catch (error) {
      return {
        ok: false,
        issues: [{
          path: "advancedYaml",
          message: error instanceof Error ? error.message : String(error),
        }],
      }
    }
  }

  if (input.config !== undefined && !isPlainObject(input.config)) {
    return {
      ok: false,
      issues: [{ path: "config", message: "OBJECT_REQUIRED" }],
    }
  }

  return { ok: true, patch: mergeConfig(advanced, input.config ?? {}) }
}

export type SetupOutcome =
  | { ok: false; status: number; error: ApiErrorCode; issues?: ConfigIssue[] }
  | {
    ok: true
    config: AppConfig
    adminCreated: boolean
    restartRequired: string | null
    configPath: string
  }

async function inspectExistingEmperor(
  config: AppConfig,
  admin: { username: string; password: string },
) {
  const owners = await listEmperorCredentials(config)
  if (owners.length === 0) return "none" as const
  if (owners.length !== 1) return "conflict" as const

  const owner = owners[0]
  if (owner.username !== admin.username || !owner.passwordHash) {
    return "conflict" as const
  }

  const verification = await verifyPassword(admin.password, owner.passwordHash, {
    passwordPepper: config.auth.passwordPepper ?? "",
    legacyAuthSecret: config.auth.secret ?? "",
  })
  return verification.valid ? "matching" as const : "conflict" as const
}

export async function completeSetup(input: unknown): Promise<SetupOutcome> {
  if (!isPlainObject(input)) {
    return { ok: false, status: 400, error: "INVALID_REQUEST" }
  }

  const admin = authSchema
    .pick({ username: true, password: true })
    .safeParse(isPlainObject(input.admin) ? input.admin : {})
  if (!admin.success) {
    return {
      ok: false,
      status: 400,
      error: "INVALID_ADMIN_INPUT",
    }
  }

  const patch = buildSetupConfigPatch(input)
  if (!patch.ok) {
    return { ok: false, status: 400, error: "ADVANCED_YAML_INVALID", issues: patch.issues }
  }

  const candidate = buildCandidateConfig(patch.patch, { completed: true })
  if (!candidate.ok) {
    return { ok: false, status: 400, error: "CONFIG_VALIDATION_FAILED", issues: candidate.issues }
  }

  const config = candidate.config
  const probeIssues = await probeDatabase(config)
  if (probeIssues.length > 0) {
    return { ok: false, status: 400, error: "DATABASE_PROBE_FAILED", issues: probeIssues }
  }

  try {
    await runMigrations(config)
  } catch (error) {
    console.error("setup.database_initialization_failed", error)
    return {
      ok: false,
      status: 500,
      error: "DATABASE_INITIALIZATION_FAILED",
    }
  }

  let existingEmperor: "none" | "matching" | "conflict"
  try {
    existingEmperor = await inspectExistingEmperor(config, admin.data)
  } catch (error) {
    console.error("setup.emperor_inspection_failed", error)
    return {
      ok: false,
      status: 500,
      error: "EMPEROR_INSPECTION_FAILED",
    }
  }
  if (existingEmperor === "conflict") {
    return {
      ok: false,
      status: 409,
      error: "EMPEROR_CONFLICT",
    }
  }

  // 先把 setup=false 与随机密钥（尤其 passwordPepper）原子落盘。
  // 即使之后进程退出或最终写入失败，重试也会复用同一 pepper，已有站主不会失去登录能力。
  const stagedConfig: AppConfig = {
    ...config,
    setup: { completed: false, completedAt: null },
  }
  const staged = await saveConfig(stagedConfig, { deferRestart: true })
  if (!staged.ok) {
    return { ok: false, status: 500, error: "CONFIG_STAGE_FAILED", issues: staged.issues }
  }

  let adminCreated = existingEmperor === "none"
  try {
    if (existingEmperor === "none") {
      const passwordHash = await hashPassword(
        admin.data.password,
        config.auth.passwordPepper ?? "",
      )
      const result = await createInitialEmperor(config, {
        username: admin.data.username,
        passwordHash,
      })
      if (result === "username_taken") {
        return { ok: false, status: 409, error: "USERNAME_ALREADY_EXISTS" }
      }
      if (result === "emperor_exists") {
        const raced = await inspectExistingEmperor(config, admin.data)
        if (raced !== "matching") {
          return {
            ok: false,
            status: 409,
            error: "EMPEROR_CONFLICT",
          }
        }
        adminCreated = false
      }
    }
  } catch (error) {
    console.error("setup.emperor_creation_failed", error)
    return {
      ok: false,
      status: 500,
      error: "EMPEROR_CREATE_FAILED",
    }
  }

  const saved = await saveConfig(config)
  if (!saved.ok) {
    return { ok: false, status: 500, error: "CONFIG_SAVE_FAILED", issues: saved.issues }
  }

  removeSetupToken()

  // 数据库类型与本进程绑定的类型不同时登记重启；生产环境会自动退出并由守护进程拉起。
  checkDriverBinding()

  return {
    ok: true,
    config: saved.config,
    adminCreated,
    restartRequired: getConfigStatus().restartRequired?.reason ?? null,
    configPath: getConfigStatus().path,
  }
}
