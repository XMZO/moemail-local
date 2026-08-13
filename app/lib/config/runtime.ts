import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  utimesSync,
  watchFile,
  unwatchFile,
  writeFileSync,
} from "node:fs"
import { createHash, randomBytes } from "node:crypto"
import { dirname } from "node:path"
import { hostname } from "node:os"
import {
  parseConfigDocument,
  readConfigFile,
  readLastKnownGoodFile,
  resolveConfigPath,
  stringifyConfig,
  writeConfigFile,
  writeLastKnownGoodFile,
} from "./file"
import type { PublicRuntimeConfig } from "./public"
import {
  type AppConfig,
  type ConfigIssue,
  createDefaultConfig,
  parseConfig,
  requiresProcessRestart,
} from "./schema"

export class ConfigError extends Error {
  constructor(readonly issues: ConfigIssue[], context: string) {
    super(context)
    this.name = "ConfigError"
  }
}

export interface ConfigChange {
  previous: AppConfig
  next: AppConfig
}

type ConfigListener = (change: ConfigChange) => void

interface BootCandidate {
  config: AppConfig
  trigger: string
  /** 主文件候选失败时，才尝试已解析的 LKG。 */
  fallback?: AppConfig
  /** 使用 LKG 时保留主文件的错误，供已授权的恢复界面诊断。 */
  rejectedIssues?: ConfigIssue[]
}

interface ConfigRuntimeState {
  path: string
  config: AppConfig
  loadedFromFile: boolean
  fileExists: boolean
  mtimeMs: number
  size: number
  observedRaw: string | null
  lastCheckedAt: number
  revision: number
  fatal: ConfigIssue[] | null
  lastError: { at: string; issues: ConfigIssue[] } | null
  restartRequired: { at: string; reason: string } | null
  restartTimer: ReturnType<typeof setTimeout> | null
  listeners: Set<ConfigListener>
  watching: boolean
  bootCandidatePending: boolean
  bootCandidate: BootCandidate | null
  operationQueue: Promise<void>
}

interface PreparedConfigChange {
  ok: true
  commit: () => void
  rollback: () => Promise<void>
  restartRequired?: boolean
}

type PrepareResult = PreparedConfigChange | { ok: false; issues: ConfigIssue[] }

type ConfigGlobals = typeof globalThis & {
  __moemailConfigState?: ConfigRuntimeState
}

const configGlobals = globalThis as ConfigGlobals
const REFRESH_INTERVAL_MS = 1_000
const WATCH_INTERVAL_MS = 1_000
const SAVE_LOCK_TIMEOUT_MS = 10_000

function log(event: string, payload: Record<string, unknown> = {}) {
  const line = JSON.stringify({ event, ...payload })
  if (event.endsWith(".failed") || event.endsWith(".missing")) console.error(line)
  else console.log(line)
}

function toIssues(error: unknown, path = "(file)"): ConfigIssue[] {
  return [{ path, message: error instanceof Error ? error.message : String(error) }]
}

function createState(): ConfigRuntimeState {
  return {
    path: resolveConfigPath(),
    config: createDefaultConfig(),
    loadedFromFile: false,
    fileExists: false,
    mtimeMs: 0,
    size: 0,
    observedRaw: null,
    lastCheckedAt: Date.now(),
    revision: 0,
    fatal: null,
    lastError: null,
    restartRequired: null,
    restartTimer: null,
    listeners: new Set(),
    watching: false,
    bootCandidatePending: false,
    bootCandidate: null,
    operationQueue: Promise.resolve(),
  }
}

function parseRawConfig(raw: string) {
  let document: unknown
  try {
    document = parseConfigDocument(raw)
  } catch (error) {
    return { ok: false as const, issues: toIssues(error) }
  }
  return parseConfig(document)
}

function observeSnapshot(
  state: ConfigRuntimeState,
  snapshot: { raw: string; mtimeMs: number; size: number },
) {
  state.fileExists = true
  state.mtimeMs = snapshot.mtimeMs
  state.size = snapshot.size
  state.observedRaw = snapshot.raw
}

function recordFailure(state: ConfigRuntimeState, issues: ConfigIssue[], trigger: string) {
  const at = new Date().toISOString()
  state.lastError = { at, issues }
  if (!state.loadedFromFile) state.fatal = issues
  log("config.load.failed", {
    trigger,
    path: state.path,
    kept: state.loadedFromFile ? "previous-config" : "none",
    issues: issues.map(issue => `${issue.path}: ${issue.message}`),
  })
}

function notifyListeners(state: ConfigRuntimeState, previous: AppConfig, next: AppConfig) {
  for (const listener of state.listeners) {
    try {
      listener({ previous, next })
    } catch (error) {
      log("config.listener.failed", {
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

function applyConfig(
  state: ConfigRuntimeState,
  next: AppConfig,
  prepared: PreparedConfigChange,
  options: { deferRestart?: boolean } = {},
) {
  const previous = state.config
  prepared.commit()
  state.config = next
  state.revision += 1
  state.lastError = null
  state.fatal = null

  if (requiresProcessRestart(previous, next)) {
    if (prepared.restartRequired === false) clearRestartRequired()
    else {
      markRestartRequired(
        "DATABASE_DRIVER_CHANGED",
        { defer: options.deferRestart },
      )
    }
  }

  notifyListeners(state, previous, next)
}

function persistLastKnownGood(state: ConfigRuntimeState) {
  try {
    writeLastKnownGoodFile(state.path, state.config)
  } catch (error) {
    log("config.lkg.write.failed", {
      path: state.path,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

function loadFromDiskAtBoot(state: ConfigRuntimeState) {
  let snapshot
  try {
    snapshot = readConfigFile(state.path)
  } catch (error) {
    recordFailure(state, toIssues(error), "boot")
    return
  }

  if (!snapshot) {
    try {
      const fallback = readLastKnownGoodFile(state.path)
      if (!fallback) return

      const fallbackParsed = parseRawConfig(fallback.raw)
      if (!fallbackParsed.ok) {
        recordFailure(state, fallbackParsed.issues, "boot-lkg")
        return
      }

      state.config = fallbackParsed.config
      state.bootCandidatePending = true
      state.bootCandidate = {
        config: fallbackParsed.config,
        trigger: "boot-lkg",
      }
      log("config.lkg.recovered", { path: state.path, reason: "primary-missing" })
      return
    } catch (error) {
      recordFailure(state, toIssues(error), "boot-lkg")
      return
    }
  }
  observeSnapshot(state, snapshot)

  const parsed = parseRawConfig(snapshot.raw)
  let fallbackConfig: AppConfig | undefined
  try {
    const fallback = readLastKnownGoodFile(state.path)
    if (fallback) {
      const fallbackParsed = parseRawConfig(fallback.raw)
      if (fallbackParsed.ok) {
        fallbackConfig = fallbackParsed.config
      }
    }
  } catch (error) {
    log("config.lkg.read.failed", {
      path: state.path,
      message: error instanceof Error ? error.message : String(error),
    })
  }

  if (parsed.ok) {
    state.config = parsed.config
    state.bootCandidatePending = true
    state.bootCandidate = {
      config: parsed.config,
      trigger: "boot-primary",
      fallback: fallbackConfig
        && JSON.stringify(fallbackConfig) !== JSON.stringify(parsed.config)
        ? fallbackConfig
        : undefined,
    }
    if (state.bootCandidate.fallback) {
      log("config.lkg.recovered", { path: state.path, reason: "candidate-pending-validation" })
    }
    return
  }

  if (fallbackConfig) {
    state.config = fallbackConfig
    state.lastError = { at: new Date().toISOString(), issues: parsed.issues }
    state.bootCandidatePending = true
    state.bootCandidate = {
      config: fallbackConfig,
      trigger: "boot-lkg",
      rejectedIssues: parsed.issues,
    }
    log("config.lkg.recovered", { path: state.path, reason: "primary-invalid" })
    return
  }

  recordFailure(state, parsed.issues, "boot")
}

async function validateBootCandidateUnlocked(
  state: ConfigRuntimeState,
  candidate: BootCandidate,
) {
  const validate = async (config: AppConfig) => {
    // getBoundDriver() 在数据库模块首次加载时读取当前 runtime 配置。
    state.config = config
    const prepared = await prepareConfigChange(
      config,
      createDefaultConfig(),
      undefined,
      config.database.driver,
    )
    if (!prepared.ok) return prepared

    // 让 applyConfig 以真正的冷启动默认态作比较；若数据库模块已经绑定了
    // 同一 driver，prepared.restartRequired=false 会正确消除伪重启。
    state.config = createDefaultConfig()
    applyConfig(state, config, prepared)
    state.loadedFromFile = true
    persistLastKnownGood(state)
    return { ok: true as const }
  }

  const primary = await validate(candidate.config)
  if (primary.ok) {
    if (candidate.rejectedIssues) {
      state.lastError = { at: new Date().toISOString(), issues: candidate.rejectedIssues }
    }
    log("config.load.applied", {
      trigger: candidate.trigger,
      path: state.path,
      revision: state.revision,
    })
    return true
  }

  if (candidate.fallback) {
    log("config.load.failed", {
      trigger: candidate.trigger,
      path: state.path,
      kept: "boot-lkg-candidate",
      issues: primary.issues.map(issue => `${issue.path}: ${issue.message}`),
    })
    const fallback = await validate(candidate.fallback)
    if (fallback.ok) {
      state.lastError = { at: new Date().toISOString(), issues: primary.issues }
      log("config.lkg.recovered", { path: state.path, reason: "candidate-validation-failed" })
      return true
    }
    recordFailure(state, fallback.issues, "boot-lkg")
    return false
  }

  recordFailure(state, primary.issues, candidate.trigger)
  return false
}

function enqueueOperation<T>(state: ConfigRuntimeState, operation: () => Promise<T>) {
  const result = state.operationQueue.then(operation, operation)
  state.operationQueue = result.then(() => undefined, () => undefined)
  return result
}

async function prepareConfigChange(
  next: AppConfig,
  previous: AppConfig,
  verify?: SaveOptions["verify"],
  boundDriver?: AppConfig["database"]["driver"],
): Promise<PrepareResult> {
  if (
    previous.setup.completed
    && previous.auth.passwordPepper !== next.auth.passwordPepper
  ) {
    return {
      ok: false,
      issues: [{
        path: "auth.passwordPepper",
        message: "PASSWORD_PEPPER_ROTATION_FORBIDDEN",
      }],
    }
  }

  if (verify) {
    try {
      const issues = await verify(next, previous)
      if (issues.length > 0) return { ok: false, issues }
    } catch (error) {
      return { ok: false, issues: toIssues(error, "(verify)") }
    }
  }

  try {
    const { prepareDatabaseConfigChange } = await import("../db")
    return await prepareDatabaseConfigChange(previous, next, { boundDriver })
  } catch (error) {
    return { ok: false, issues: toIssues(error, "database") }
  }
}

async function loadFromDiskUnlocked(
  state: ConfigRuntimeState,
  trigger: string,
  force: boolean,
  attempt = 0,
) {
  state.lastCheckedAt = Date.now()

  let snapshot
  try {
    snapshot = readConfigFile(state.path)
  } catch (error) {
    recordFailure(state, toIssues(error), trigger)
    return false
  }

  if (!snapshot) {
    if (state.fileExists) {
      log("config.file.missing", { trigger, path: state.path, kept: "previous-config" })
    }
    state.fileExists = false
    state.mtimeMs = 0
    state.size = 0
    state.observedRaw = null
    return false
  }

  if (!force && state.fileExists && snapshot.raw === state.observedRaw) {
    return !state.lastError
  }

  observeSnapshot(state, snapshot)
  const parsed = parseRawConfig(snapshot.raw)
  if (!parsed.ok) {
    recordFailure(state, parsed.issues, trigger)
    return false
  }

  const changed = !state.loadedFromFile
    || JSON.stringify(parsed.config) !== JSON.stringify(state.config)
  if (!changed) {
    state.loadedFromFile = true
    state.lastError = null
    state.fatal = null
    persistLastKnownGood(state)
    return true
  }

  const previousForValidation = state.loadedFromFile
    ? state.config
    : createDefaultConfig()
  const prepared = await prepareConfigChange(parsed.config, previousForValidation)
  if (!prepared.ok) {
    recordFailure(state, prepared.issues, trigger)
    return false
  }

  let latestSnapshot
  try {
    latestSnapshot = readConfigFile(state.path)
  } catch (error) {
    await prepared.rollback()
    recordFailure(state, toIssues(error), trigger)
    return false
  }

  if (!latestSnapshot || latestSnapshot.raw !== snapshot.raw) {
    await prepared.rollback()
    if (!latestSnapshot) {
      state.fileExists = false
      state.mtimeMs = 0
      state.size = 0
      state.observedRaw = null
      return false
    }
    if (attempt < 2) {
      return loadFromDiskUnlocked(state, `${trigger}-superseded`, true, attempt + 1)
    }
    state.observedRaw = null
    log("config.load.superseded", { trigger, path: state.path })
    return false
  }

  try {
    applyConfig(state, parsed.config, prepared)
  } catch (error) {
    await prepared.rollback()
    recordFailure(state, toIssues(error, "(apply)"), trigger)
    return false
  }

  state.loadedFromFile = true
  persistLastKnownGood(state)
  log("config.load.applied", { trigger, path: state.path, revision: state.revision })
  return true
}

function requestRefresh(state: ConfigRuntimeState, trigger: string, force = false) {
  state.lastCheckedAt = Date.now()
  return enqueueOperation(state, () => loadFromDiskUnlocked(state, trigger, force))
}

function startWatcher(state: ConfigRuntimeState) {
  if (state.watching) return
  state.watching = true

  const watcher = watchFile(
    state.path,
    { interval: WATCH_INTERVAL_MS, persistent: false },
    () => {
      void requestRefresh(state, "watch").catch(error => {
        recordFailure(state, toIssues(error), "watch")
      })
    },
  )
  watcher.unref?.()
}

function ensureState() {
  let state = configGlobals.__moemailConfigState
  if (!state) {
    state = createState()
    configGlobals.__moemailConfigState = state
    loadFromDiskAtBoot(state)
    startWatcher(state)
    if (state.bootCandidatePending && state.bootCandidate) {
      const bootCandidate = state.bootCandidate
      state.bootCandidate = null
      const initializedState = state
      void enqueueOperation(
        initializedState,
        () => validateBootCandidateUnlocked(initializedState, bootCandidate),
      ).catch(error => {
        recordFailure(initializedState, toIssues(error), "boot-candidate")
      }).finally(() => {
        initializedState.bootCandidatePending = false
      })
    }
    return state
  }

  if (Date.now() - state.lastCheckedAt >= REFRESH_INTERVAL_MS) {
    void requestRefresh(state, "poll").catch(error => {
      recordFailure(state, toIssues(error), "poll")
    })
  }
  return state
}

export function markRestartRequired(
  reason: string,
  options: { defer?: boolean } = {},
) {
  const state = ensureState()
  if (!state.restartRequired) {
    state.restartRequired = { at: new Date().toISOString(), reason }
    log("config.restart.required", { reason })
  }

  if (options.defer) {
    log("config.restart.deferred", { reason: state.restartRequired.reason })
    return state.restartRequired
  }

  if (!state.config.server.autoRestartOnDriverChange) return state.restartRequired
  if (process.env.NODE_ENV !== "production") {
    log("config.restart.manual", { reason, hint: "MANUAL_RESTART_REQUIRED" })
    return state.restartRequired
  }

  if (state.restartTimer) return state.restartRequired

  log("config.restart.scheduled", { reason, delayMs: 1_500 })
  state.restartTimer = setTimeout(() => {
    log("config.restart.exit", { reason })
    process.exit(0)
  }, 1_500)
  return state.restartRequired
}

function clearRestartRequired() {
  const state = ensureState()
  if (state.restartTimer) clearTimeout(state.restartTimer)
  state.restartTimer = null
  state.restartRequired = null
  log("config.restart.cleared")
}

export function getConfig(): AppConfig {
  const state = ensureState()
  if (state.fatal) {
    throw new ConfigError(state.fatal, "CONFIG_NOT_LOADED")
  }
  if (state.bootCandidatePending) {
    throw new ConfigError([{
      path: "(boot)",
      message: "BOOT_CONFIG_VALIDATION_PENDING",
    }], "CONFIG_NOT_VALIDATED")
  }
  return state.config
}

/**
 * 仅供一次性 setup token 保护的恢复流程使用。返回的是已通过 YAML/schema
 * 解析但可能尚未通过数据库验证的候选值，用来保留原 pepper/secret；普通
 * 请求必须继续使用 getConfig()，不能绕过 fatal gate。
 */
export function getSetupRecoveryConfig(): AppConfig {
  return ensureState().config
}

export function getConfigStatus() {
  const state = ensureState()
  return {
    path: state.path,
    fileExists: state.fileExists,
    loadedFromFile: state.loadedFromFile,
    bootCandidatePending: state.bootCandidatePending,
    revision: state.revision,
    setupCompleted: state.loadedFromFile && state.config.setup.completed,
    fatal: state.fatal,
    lastError: state.lastError,
    restartRequired: state.restartRequired,
  }
}

export function isSetupCompleted() {
  const state = ensureState()
  return !state.fatal && state.loadedFromFile && state.config.setup.completed
}

export function getConfigPath() {
  return ensureState().path
}

export function getPublicRuntimeConfig(): PublicRuntimeConfig {
  const config = getConfig()
  return {
    baseUrl: config.server.baseUrl,
    emailPollIntervalMs: config.server.emailPollIntervalMs,
    oauth: {
      github: Boolean(config.auth.github.clientId && config.auth.github.clientSecret),
      google: Boolean(config.auth.google.clientId && config.auth.google.clientSecret),
    },
  }
}

export function onConfigChange(listener: ConfigListener) {
  const state = ensureState()
  state.listeners.add(listener)
  return () => {
    state.listeners.delete(listener)
  }
}

export async function reloadConfig() {
  const state = ensureState()
  const ok = await requestRefresh(state, "manual", true)
  return {
    ok,
    issues: state.lastError?.issues ?? [],
  }
}

/**
 * 等待冷启动时已经排队的数据库/站主校验完成，但不重新读取或再次探测
 * 同一个磁盘候选。instrumentation 与一次性运维进程用它来跨过 boot gate；
 * 操作者明确要求重试磁盘内容时仍应调用 reloadConfig()。
 */
export async function awaitInitialConfigReady() {
  const state = ensureState()
  while (state.bootCandidatePending) {
    // boot 校验的 finally（负责清除 pending）不属于 operationQueue 本身；
    // 多让出一个 microtask，确保状态清理由同一轮 promise 链完成。
    await state.operationQueue
    await Promise.resolve()
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function mergeConfig(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base
  if (!isPlainObject(patch) || !isPlainObject(base)) return patch

  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    merged[key] = isPlainObject(value) ? mergeConfig(base[key] ?? {}, value) : value
  }
  return merged
}

export type SaveResult =
  | { ok: true; config: AppConfig; restartRequired: boolean; revision: number }
  | { ok: false; issues: ConfigIssue[] }

export interface SaveOptions {
  verify?: (config: AppConfig, previous: AppConfig) => Promise<ConfigIssue[]>
  expectedRevision?: number
  /** 跨进程安全的文件内容 CAS；revision 只适合单个 Node 进程。 */
  expectedFingerprint?: string
  /** 初始化两阶段提交会先持久化密钥，此时只登记、暂不执行进程重启。 */
  deferRestart?: boolean
}

function revisionIssue(): ConfigIssue[] {
  return [{
    path: "(revision)",
    message: "CONFIG_REVISION_CONFLICT",
  }]
}

export function configFingerprint(raw: string | null) {
  return createHash("sha256")
    .update(raw === null ? "missing\0" : `present\0${raw}`)
    .digest("hex")
}

interface SaveLockRecord {
  nonce: string
  pid: number
  hostname: string
  createdAt: string
}

function lockOwnerIsGone(record: Partial<SaveLockRecord>) {
  if (record.hostname !== hostname() || !Number.isInteger(record.pid)) return false
  try {
    process.kill(record.pid as number, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
  }
}

interface ConfigSaveLock {
  assertOwned: () => void
  release: () => void
}

async function acquireConfigSaveLock(path: string): Promise<ConfigSaveLock> {
  const lockPath = `${path}.save.lock`
  const nonce = randomBytes(16).toString("hex")
  const record: SaveLockRecord = {
    nonce,
    pid: process.pid,
    hostname: hostname(),
    createdAt: new Date().toISOString(),
  }
  const deadline = Date.now() + SAVE_LOCK_TIMEOUT_MS
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })

  while (true) {
    let descriptor: number | undefined
    try {
      descriptor = openSync(lockPath, "wx", 0o600)
      writeFileSync(descriptor, JSON.stringify(record), "utf8")
      try {
        chmodSync(lockPath, 0o600)
      } catch {
        // Windows 与部分文件系统不支持 POSIX 权限位。
      }

      const heartbeat = setInterval(() => {
        try {
          const current = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<SaveLockRecord>
          if (current.nonce === nonce) utimesSync(lockPath, new Date(), new Date())
        } catch {
          // release 或数据卷暂时不可用时无需让心跳异常中断保存流程。
        }
      }, 60_000)
      heartbeat.unref?.()
      let released = false
      const assertOwned = () => {
        const current = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<SaveLockRecord>
        if (current.nonce !== nonce) {
          throw new Error("CONFIG_SAVE_LOCK_LOST")
        }
      }
      const release = () => {
        if (released) return
        released = true
        clearInterval(heartbeat)
        try {
          closeSync(descriptor as number)
        } catch {}
        try {
          const current = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<SaveLockRecord>
          if (current.nonce === nonce) rmSync(lockPath, { force: true })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            log("config.save.lock.release.failed", {
              path: lockPath,
              message: error instanceof Error ? error.message : String(error),
            })
          }
        }
      }
      return { assertOwned, release }
    } catch (error) {
      const createdLock = descriptor !== undefined
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor)
        } catch {}
      }
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EEXIST") {
        if (createdLock) {
          try {
            rmSync(lockPath, { force: true })
          } catch {}
        }
        throw error
      }

      try {
        let owner: Partial<SaveLockRecord> = {}
        let observedLockRaw = ""
        try {
          observedLockRaw = readFileSync(lockPath, "utf8")
          owner = JSON.parse(observedLockRaw) as Partial<SaveLockRecord>
        } catch {}
        // 能确认同机 owner 已退出时才回收。年龄不能证明 owner 已死：进程被
        // SIGSTOP/长 GC 后仍可能恢复并提交，按 mtime 偷锁会绕过 CAS。
        if (lockOwnerIsGone(owner)) {
          if (readFileSync(lockPath, "utf8") !== observedLockRaw) continue
          rmSync(lockPath, { force: true })
          continue
        }
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code === "ENOENT") continue
        throw lockError
      }

      if (Date.now() >= deadline) {
        throw new Error("CONFIG_SAVE_LOCK_BUSY")
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
}

async function saveConfigUnlocked(
  state: ConfigRuntimeState,
  input: unknown,
  options: SaveOptions,
  assertLockOwned: () => void,
): Promise<SaveResult> {
  if (
    options.expectedRevision !== undefined
    && options.expectedRevision !== state.revision
  ) {
    return { ok: false, issues: revisionIssue() }
  }
  if (
    options.expectedFingerprint !== undefined
    && options.expectedFingerprint !== configFingerprint(
      state.fileExists ? state.observedRaw : null,
    )
  ) {
    return {
      ok: false,
      issues: [{
        path: "(fingerprint)",
        message: "CONFIG_FINGERPRINT_CONFLICT",
      }],
    }
  }

  const parsed = parseConfig(input)
  if (!parsed.ok) return { ok: false, issues: parsed.issues }

  const baselineRaw = state.fileExists ? state.observedRaw : null
  const prepared = await prepareConfigChange(parsed.config, state.config, options.verify)
  if (!prepared.ok) return { ok: false, issues: prepared.issues }

  let latestSnapshot
  try {
    assertLockOwned()
    latestSnapshot = readConfigFile(state.path)
  } catch (error) {
    await prepared.rollback()
    return { ok: false, issues: toIssues(error) }
  }

  if ((latestSnapshot?.raw ?? null) !== baselineRaw) {
    await prepared.rollback()
    await loadFromDiskUnlocked(state, "save-conflict", true)
    return {
      ok: false,
      issues: state.lastError?.issues ?? [{
        path: "(revision)",
        message: "CONFIG_CHANGED_DURING_SAVE",
      }],
    }
  }

  const raw = stringifyConfig(parsed.config)
  let stats
  try {
    assertLockOwned()
    stats = writeConfigFile(state.path, parsed.config)
  } catch (error) {
    await prepared.rollback()
    return { ok: false, issues: toIssues(error) }
  }

  try {
    const changed = JSON.stringify(state.config) !== JSON.stringify(parsed.config)
    if (changed) {
      applyConfig(state, parsed.config, prepared, {
        deferRestart: options.deferRestart,
      })
    }
    else prepared.commit()
  } catch (error) {
    await prepared.rollback()
    return { ok: false, issues: toIssues(error, "(apply)") }
  }

  state.fileExists = true
  state.loadedFromFile = true
  state.mtimeMs = stats?.mtimeMs ?? 0
  state.size = stats?.size ?? Buffer.byteLength(raw, "utf8")
  state.observedRaw = raw
  state.lastCheckedAt = Date.now()
  state.lastError = null
  state.fatal = null
  persistLastKnownGood(state)
  startWatcher(state)

  log("config.save.applied", { path: state.path, revision: state.revision })
  return {
    ok: true,
    config: parsed.config,
    restartRequired: Boolean(state.restartRequired),
    revision: state.revision,
  }
}

export function saveConfig(input: unknown, options: SaveOptions = {}): Promise<SaveResult> {
  const state = ensureState()
  return enqueueOperation(state, async () => {
    let lock: ConfigSaveLock | undefined
    try {
      lock = await acquireConfigSaveLock(state.path)
      await loadFromDiskUnlocked(state, "pre-save", false)
      return await saveConfigUnlocked(state, input, options, lock.assertOwned)
    } catch (error) {
      return { ok: false, issues: toIssues(error, "(lock)") }
    } finally {
      lock?.release()
    }
  })
}

export function saveConfigPatch(patch: unknown, options: SaveOptions = {}) {
  const state = ensureState()
  return enqueueOperation(state, async () => {
    let lock: ConfigSaveLock | undefined
    try {
      lock = await acquireConfigSaveLock(state.path)
      await loadFromDiskUnlocked(state, "pre-save", false)
      return await saveConfigUnlocked(
        state,
        mergeConfig(state.config, patch),
        options,
        lock.assertOwned,
      )
    } catch (error) {
      return { ok: false, issues: toIssues(error, "(lock)") }
    } finally {
      lock?.release()
    }
  })
}

/** Release the non-persistent watcher used by isolated validators and tests. */
export async function closeConfigRuntime() {
  const state = configGlobals.__moemailConfigState
  if (!state) return
  unwatchFile(state.path)
  state.watching = false
  if (state.restartTimer) {
    clearTimeout(state.restartTimer)
    state.restartTimer = null
  }
  await state.operationQueue.catch(() => undefined)
}
