import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const repositoryRoot = process.cwd()
const temporaryRoot = mkdtempSync(join(tmpdir(), "moemail-runtime-config-"))
const tsxCli = resolve(repositoryRoot, "node_modules/tsx/dist/cli.mjs")
const casProbe = resolve(repositoryRoot, "scripts/validation/runtime-config-cas-probe.ts")

function runCasProbe(id: "a" | "b", pollValue: number) {
  return new Promise<{ id: string; ok: boolean; conflict: boolean }>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [tsxCli, casProbe, id, String(pollValue)], {
      cwd: temporaryRoot,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`CAS probe ${id} timed out`))
    }, 30_000)
    child.stdout.on("data", chunk => { stdout += String(chunk) })
    child.stderr.on("data", chunk => { stderr += String(chunk) })
    child.once("error", error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("exit", code => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`CAS probe ${id} exited ${code}: ${stderr}\n${stdout}`))
        return
      }
      const marker = stdout
        .split(/\r?\n/)
        .find(line => line.startsWith("__MOEMAIL_CAS_PROBE__"))
      if (!marker) {
        reject(new Error(`CAS probe ${id} returned no result: ${stdout}`))
        return
      }
      resolvePromise(JSON.parse(marker.slice("__MOEMAIL_CAS_PROBE__".length)))
    })
  })
}

async function waitFor(check: () => boolean, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`)
}

try {
  cpSync(
    resolve(repositoryRoot, "drizzle-local"),
    resolve(temporaryRoot, "drizzle-local"),
    { recursive: true },
  )
  process.chdir(temporaryRoot)

  const runtime = await import(pathToFileURL(
    resolve(repositoryRoot, "app/lib/config/runtime.ts"),
  ).href)
  const file = await import(pathToFileURL(
    resolve(repositoryRoot, "app/lib/config/file.ts"),
  ).href)
  const schema = await import(pathToFileURL(
    resolve(repositoryRoot, "app/lib/config/schema.ts"),
  ).href)
  const database = await import(pathToFileURL(
    resolve(repositoryRoot, "app/lib/db.ts"),
  ).href)
  const databaseSetup = await import(pathToFileURL(
    resolve(repositoryRoot, "app/lib/database-setup.ts"),
  ).href)
  const password = await import(pathToFileURL(
    resolve(repositoryRoot, "app/lib/password.ts"),
  ).href)

  const defaults = schema.createDefaultConfig()
  const typo = schema.parseConfig({
    server: { emailPollIntervlMs: 5_000 },
    databsae: { driver: "postgres" },
  })
  assert.equal(typo.ok, false)
  const unsafePostgresBackup = schema.parseConfig({
    database: { postgres: { backupDir: "data/outside-postgres-volume" } },
  })
  assert.equal(unsafePostgresBackup.ok, false)
  assert.equal(schema.parseConfig({
    database: { postgres: { backupDir: "data\\postgres-backups" } },
  }).ok, false)
  for (const invalidPostgresUrl of [
    "postgresql://user@example.test/moemail?sslmode=require",
    "postgresql://user@example.test/moemail?host=other.example.test",
    "postgresql:///moemail",
    "postgresql://user@example.test",
    "postgresql://example.test/moemail",
  ]) {
    assert.equal(schema.parseConfig({
      database: {
        driver: "postgres",
        postgres: { url: invalidPostgresUrl },
      },
    }).ok, false)
  }
  assert.equal(schema.parseConfig({
    database: {
      driver: "postgres",
      postgres: { url: "postgresql://moemail@[2001:db8::1]:5432/moemail" },
    },
  }).ok, true)
  assert.equal(schema.parseConfig({
    setup: { completed: true },
    auth: { secret: "auth-secret-abcdefghijklmnopqrstuvwxyz-123456" },
    email: { ingestSecret: "ingest-secret-abcdefghijklmnopqrstuvwxyz-123" },
  }).ok, false)
  for (const unsafeSqliteConfig of [
    { database: { sqlite: { path: "outside.db" } } },
    { database: { sqlite: { path: "../outside.db" } } },
    { database: { sqlite: { path: "data\\outside.db" } } },
    { database: { sqlite: { path: "data/config.yaml" } } },
    { database: { sqlite: { path: "data/CONFIG.YAML.LKG" } } },
    { database: { sqlite: { path: "data/config.yaml.save.lock/database.db" } } },
    { database: { sqlite: { path: "data/setup-token" } } },
    { database: { sqlite: { path: "data/setup-operation.lock/database.db" } } },
    { database: { sqlite: { backupDir: "backups" } } },
    { database: { sqlite: { backupDir: "data/../outside" } } },
    { database: { sqlite: { backupDir: "data/config.yaml.lkg" } } },
    {
      database: {
        sqlite: { path: "data/database.db", backupDir: "data/database.db" },
      },
    },
    {
      database: {
        sqlite: { path: "data/database.db", backupDir: "data/database.db/backups" },
      },
    },
    ...["-wal", "-shm", "-journal", ".cleanup.lock"].flatMap(suffix => [
      {
        database: {
          sqlite: { path: "data/database.db", backupDir: `data/database.db${suffix}` },
        },
      },
      {
        database: {
          sqlite: { path: "data/database.db", backupDir: `data/database.db${suffix}/nested` },
        },
      },
    ]),
  ]) {
    assert.equal(schema.parseConfig(unsafeSqliteConfig).ok, false)
  }
  const rcloneConfig = schema.parseConfig({
    offsite: { rcloneConfigContent: "[archive]\ntype = local\n" },
  })
  assert.equal(rcloneConfig.ok, true)
  const initial = {
    ...defaults,
    setup: { completed: true, completedAt: new Date().toISOString() },
    server: { ...defaults.server, baseUrl: "http://127.0.0.1:3000" },
    database: {
      ...defaults.database,
      driver: "sqlite" as const,
      sqlite: { ...defaults.database.sqlite, path: "data/runtime-test.db" },
    },
    auth: {
      ...defaults.auth,
      secret: "auth-secret-abcdefghijklmnopqrstuvwxyz-123456",
      passwordPepper: "password-pepper-abcdefghijklmnopqrstuvwxyz",
    },
    email: {
      ...defaults.email,
      ingestSecret: "ingest-secret-abcdefghijklmnopqrstuvwxyz-1234",
    },
  }

  const staged = await runtime.saveConfig({
    ...initial,
    setup: { completed: false, completedAt: null },
  })
  assert.equal(staged.ok, true)
  const passwordHash = await password.hashPassword(
    "runtime-config-owner-password",
    initial.auth.passwordPepper ?? "",
  )
  assert.equal(await databaseSetup.createInitialEmperor(initial, {
    username: "runtime-owner",
    passwordHash,
  }), "created")

  const saved = await runtime.saveConfig(initial)
  assert.equal(saved.ok, true)
  assert.equal(runtime.getConfig().server.emailPollIntervalMs, 25_000)
  assert.equal(existsSync(`${runtime.getConfigPath()}.lkg`), true)

  const yamlSecretCanary = "YAML-SECRET-CANARY-abcdefghijklmnopqrstuvwxyz-0123456789"
  let capturedParseLog = ""
  const originalConsoleError = console.error
  console.error = (...values: unknown[]) => {
    capturedParseLog += values.map(String).join(" ")
    originalConsoleError(...values)
  }
  writeFileSync(
    runtime.getConfigPath(),
    `auth:\n  secret: [${yamlSecretCanary}\n`,
    "utf8",
  )
  const brokenYaml = await runtime.reloadConfig()
  console.error = originalConsoleError
  assert.equal(brokenYaml.ok, false)
  assert.doesNotMatch(JSON.stringify(brokenYaml), new RegExp(yamlSecretCanary))
  assert.doesNotMatch(
    JSON.stringify(runtime.getConfigStatus().lastError),
    new RegExp(yamlSecretCanary),
  )
  assert.doesNotMatch(capturedParseLog, new RegExp(yamlSecretCanary))
  assert.equal(runtime.getConfig().server.emailPollIntervalMs, 25_000)

  const badDatabase = {
    ...runtime.getConfig(),
    database: {
      ...runtime.getConfig().database,
      sqlite: { ...runtime.getConfig().database.sqlite, path: "." },
    },
  }
  writeFileSync(runtime.getConfigPath(), file.stringifyConfig(badDatabase), "utf8")
  const brokenDatabase = await runtime.reloadConfig()
  assert.equal(brokenDatabase.ok, false)
  assert.equal(runtime.getConfig().database.sqlite.path, "data/runtime-test.db")

  const emptyTarget = {
    ...runtime.getConfig(),
    database: {
      ...runtime.getConfig().database,
      sqlite: { ...runtime.getConfig().database.sqlite, path: "data/empty-target.db" },
    },
  }
  writeFileSync(runtime.getConfigPath(), file.stringifyConfig(emptyTarget), "utf8")
  const emptyTargetResult = await runtime.reloadConfig()
  assert.equal(emptyTargetResult.ok, false)
  assert.equal(runtime.getConfig().database.sqlite.path, "data/runtime-test.db")
  assert.equal(existsSync(resolve(temporaryRoot, "data/empty-target.db")), false)

  const validEdit = {
    ...runtime.getConfig(),
    server: { ...runtime.getConfig().server, emailPollIntervalMs: 30_000 },
  }
  writeFileSync(runtime.getConfigPath(), file.stringifyConfig(validEdit), "utf8")
  const reloaded = await runtime.reloadConfig()
  assert.equal(reloaded.ok, true)
  assert.equal(runtime.getConfig().server.emailPollIntervalMs, 30_000)

  const beforeExternalEdit = file.readConfigFile(runtime.getConfigPath())
  assert.ok(beforeExternalEdit)
  const staleFingerprint = runtime.configFingerprint(beforeExternalEdit.raw)
  const externalEdit = {
    ...runtime.getConfig(),
    server: { ...runtime.getConfig().server, emailPollIntervalMs: 32_000 },
  }
  writeFileSync(runtime.getConfigPath(), file.stringifyConfig(externalEdit), "utf8")
  const staleSave = await runtime.saveConfig({
    ...runtime.getConfig(),
    server: { ...runtime.getConfig().server, emailPollIntervalMs: 31_000 },
  }, { expectedFingerprint: staleFingerprint })
  assert.equal(staleSave.ok, false)
  assert.equal(runtime.getConfig().server.emailPollIntervalMs, 32_000)

  const revision = runtime.getConfigStatus().revision
  const first = runtime.saveConfig({
    ...runtime.getConfig(),
    server: { ...runtime.getConfig().server, emailPollIntervalMs: 35_000 },
  }, { expectedRevision: revision })
  const second = runtime.saveConfig({
    ...runtime.getConfig(),
    server: { ...runtime.getConfig().server, emailPollIntervalMs: 40_000 },
  }, { expectedRevision: revision })
  const outcomes = await Promise.all([first, second])
  assert.equal(outcomes.filter(outcome => outcome.ok).length, 1)
  assert.equal(outcomes.filter(outcome => !outcome.ok).length, 1)

  const watchedEdit = {
    ...runtime.getConfig(),
    server: { ...runtime.getConfig().server, emailPollIntervalMs: 45_000 },
  }
  writeFileSync(runtime.getConfigPath(), file.stringifyConfig(watchedEdit), "utf8")
  await waitFor(() => runtime.getConfig().server.emailPollIntervalMs === 45_000)

  await database.closeDatabase()
  const processOutcomes = await Promise.all([
    runCasProbe("a", 50_000),
    runCasProbe("b", 55_000),
  ])
  assert.equal(processOutcomes.filter(outcome => outcome.ok).length, 1)
  assert.equal(processOutcomes.filter(outcome => outcome.conflict).length, 1)
  assert.equal(existsSync(`${runtime.getConfigPath()}.save.lock`), false)

  await waitFor(() => [50_000, 55_000].includes(
    runtime.getConfig().server.emailPollIntervalMs,
  ))
  await database.closeDatabase()
  console.log(JSON.stringify({
    yamlHotReload: true,
    invalidYamlRejected: true,
    invalidDatabaseRejected: true,
    emptyDatabaseSwitchRejected: true,
    lastKnownGoodPreserved: true,
    revisionCas: true,
    externalEditFingerprintCas: true,
    simultaneousWebProcessCas: true,
    unknownKeysRejected: true,
    unsafeSqliteVolumePathsRejected: true,
    unsafePostgresBackupPathRejected: true,
    ambiguousPostgresUrlsRejected: true,
    rcloneConfigAcceptedInYaml: true,
    yamlParseErrorsRedacted: true,
    watcherAppliedWithoutManualReload: true,
  }, null, 2))
} finally {
  const state = (globalThis as typeof globalThis & {
    __moemailConfigState?: { path?: string }
  }).__moemailConfigState
  if (state) {
    const runtime = await import(pathToFileURL(
      resolve(repositoryRoot, "app/lib/config/runtime.ts"),
    ).href)
    const database = await import(pathToFileURL(
      resolve(repositoryRoot, "app/lib/db.ts"),
    ).href)
    await runtime.closeConfigRuntime()
    await database.closeDatabase()
  }
  process.chdir(repositoryRoot)
  rmSync(temporaryRoot, { recursive: true, force: true })
}
