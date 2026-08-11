import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import Database from "better-sqlite3"
import {
  writeConfigFile,
  writeLastKnownGoodFile,
} from "../../app/lib/config/file"
import type { AppConfig } from "../../app/lib/config/schema"
import { writeBackupConfigSnapshot } from "../ops/backup-config-snapshot"
import {
  backupConfigSnapshotPath,
  loadTrustedConfigFile,
} from "../ops/trusted-config"
import { verifyDatabase } from "../sqlite/lib"

const repositoryRoot = process.cwd()
const temporaryRoot = mkdtempSync(join(tmpdir(), "moemail-node-restore-"))
const tsxCli = resolve(repositoryRoot, "node_modules/tsx/dist/cli.mjs")
const setupProbe = resolve(
  repositoryRoot,
  "scripts/validation/setup-recovery-probe.ts",
)
const sqliteRestore = resolve(repositoryRoot, "scripts/sqlite/restore.ts")

function sha256(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function installedPaths(cwd: string) {
  const primary = join(cwd, "data/config.yaml")
  return {
    primary,
    lastKnownGood: `${primary}.lkg`,
    setupToken: join(cwd, "data/setup-token"),
  }
}

function writeInstalledConfig(cwd: string, config: AppConfig) {
  const paths = installedPaths(cwd)
  writeConfigFile(paths.primary, config)
  writeLastKnownGoodFile(paths.primary, config)
  return paths
}

function prepareScenario(name: string) {
  const cwd = join(temporaryRoot, name)
  mkdirSync(join(cwd, "data/backups"), { recursive: true })
  return cwd
}

function createPairedBackup(
  cwd: string,
  templateDatabase: string,
  config: AppConfig,
  options: {
    removeEmperor?: boolean
    dropMessageHtml?: boolean
    dropSiteConfigPrimaryKey?: boolean
    emailAddressLowerIndex?: "concatenated-expression" | "partial"
  } = {},
) {
  const backup = join(cwd, "data/backups/moemail-2026-08-11T00-00-00.000Z.db")
  copyFileSync(templateDatabase, backup)
  if (options.removeEmperor) {
    const sqlite = new Database(backup)
    try {
      sqlite.exec("DELETE FROM user_role")
    } finally {
      sqlite.close()
    }
  }
  if (options.dropMessageHtml) {
    const sqlite = new Database(backup)
    try {
      sqlite.exec("ALTER TABLE message DROP COLUMN html")
    } finally {
      sqlite.close()
    }
  }
  if (options.dropSiteConfigPrimaryKey) {
    const sqlite = new Database(backup)
    try {
      sqlite.exec(`
        ALTER TABLE site_config RENAME TO site_config_old;
        CREATE TABLE site_config (
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO site_config (key, value, updated_at)
          SELECT key, value, updated_at FROM site_config_old;
        DROP TABLE site_config_old;
      `)
    } finally {
      sqlite.close()
    }
  }
  if (options.emailAddressLowerIndex) {
    const sqlite = new Database(backup)
    try {
      sqlite.exec("DROP INDEX email_address_lower_idx")
      if (options.emailAddressLowerIndex === "concatenated-expression") {
        sqlite.exec(`
          CREATE UNIQUE INDEX email_address_lower_idx
          ON email (LOWER(address) || id)
        `)
      } else {
        sqlite.exec(`
          CREATE UNIQUE INDEX email_address_lower_idx
          ON email (LOWER(address))
          WHERE address <> ''
        `)
      }
    } finally {
      sqlite.close()
    }
  }
  writeBackupConfigSnapshot(backup, config)
  return backup
}

function runRestore(cwd: string, backup: string, expectedStatus: number) {
  const result = spawnSync(
    process.execPath,
    [tsxCli, sqliteRestore, backup, "--force"],
    { cwd, encoding: "utf8" },
  )
  assert.equal(
    result.status,
    expectedStatus,
    `restore exit=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  )
  return result
}

function assertRecoveryConfigInstalled(cwd: string, recoveryConfig: AppConfig) {
  const paths = installedPaths(cwd)
  assert.deepEqual(loadTrustedConfigFile(paths.primary), recoveryConfig)
  assert.deepEqual(loadTrustedConfigFile(paths.lastKnownGood), recoveryConfig)
  assert.deepEqual(readFileSync(paths.primary), readFileSync(paths.lastKnownGood))
  assert.equal(existsSync(paths.setupToken), false)
}

function safetyBackups(cwd: string) {
  return readdirSync(join(cwd, "data"))
    .filter(name => /^recovered\.db\.pre-restore-.+\.bak$/.test(name))
    .map(name => join(cwd, "data", name))
}

function assertNoRestoreTemporaryArtifacts(cwd: string) {
  const leftovers = readdirSync(join(cwd, "data"))
    .filter(name => name.includes(".restore.") && (
      name.includes(".tmp") || name.endsWith("-wal") || name.endsWith("-shm")
    ))
  assert.deepEqual(leftovers, [])
}

try {
  const template = join(temporaryRoot, "template")
  mkdirSync(join(template, "data"), { recursive: true })
  cpSync(resolve(repositoryRoot, "drizzle-local"), join(template, "drizzle-local"), {
    recursive: true,
  })
  execFileSync(process.execPath, [tsxCli, setupProbe, "normal"], {
    cwd: template,
    encoding: "utf8",
  })

  const templateDatabase = join(template, "data/setup.db")
  const templateConfig = loadTrustedConfigFile(join(template, "data/config.yaml.lkg"))
  assert.equal(verifyDatabase(templateDatabase).securityInvariants.emperorUsers, 1)

  const recoveryConfig: AppConfig = {
    ...templateConfig,
    server: {
      ...templateConfig.server,
      emailPollIntervalMs: 31_111,
    },
    database: {
      ...templateConfig.database,
      driver: "sqlite",
      sqlite: {
        ...templateConfig.database.sqlite,
        path: "data/recovered.db",
        backupDir: "data/backups",
      },
    },
    auth: {
      ...templateConfig.auth,
      secret: "recovery-auth-secret-0123456789-abcdef",
      passwordPepper: "recovery-password-pepper-0123456789-abcdef",
    },
    email: {
      ...templateConfig.email,
      ingestSecret: "recovery-ingest-secret-0123456789-abcdef",
    },
  }
  const oldConfig: AppConfig = {
    ...recoveryConfig,
    server: {
      ...recoveryConfig.server,
      emailPollIntervalMs: 42_222,
    },
    auth: {
      ...recoveryConfig.auth,
      secret: "previous-auth-secret-0123456789-abcdef",
      passwordPepper: "previous-password-pepper-0123456789-abcdef",
    },
    email: {
      ...recoveryConfig.email,
      ingestSecret: "previous-ingest-secret-0123456789-abcdef",
    },
  }

  function assertInvalidLowerAddressIndexRejected(
    name: string,
    variant: "concatenated-expression" | "partial",
    expectedError: RegExp,
  ) {
    const scenario = prepareScenario(name)
    const paths = writeInstalledConfig(scenario, oldConfig)
    writeFileSync(paths.setupToken, `preserve-${name}-token\n`, "utf8")
    const destination = join(scenario, "data/recovered.db")
    copyFileSync(templateDatabase, destination)
    const before = {
      primary: readFileSync(paths.primary),
      lastKnownGood: readFileSync(paths.lastKnownGood),
      setupToken: readFileSync(paths.setupToken),
      databaseHash: sha256(destination),
    }
    const backup = createPairedBackup(
      scenario,
      templateDatabase,
      recoveryConfig,
      { emailAddressLowerIndex: variant },
    )

    const result = runRestore(scenario, backup, 1)
    assert.match(result.stderr, expectedError)
    assert.deepEqual(readFileSync(paths.primary), before.primary)
    assert.deepEqual(readFileSync(paths.lastKnownGood), before.lastKnownGood)
    assert.deepEqual(readFileSync(paths.setupToken), before.setupToken)
    assert.equal(sha256(destination), before.databaseHash)
    assert.equal(safetyBackups(scenario).length, 0)
    assertNoRestoreTemporaryArtifacts(scenario)
  }

  // 已安装配置可以与恢复点不同；数据库验证成功后才切换配置。
  const existingSuccess = prepareScenario("existing-success")
  const existingPaths = writeInstalledConfig(existingSuccess, oldConfig)
  writeFileSync(existingPaths.setupToken, "old-setup-token\n", "utf8")
  copyFileSync(templateDatabase, join(existingSuccess, "data/recovered.db"))
  const existingBackup = createPairedBackup(
    existingSuccess,
    templateDatabase,
    recoveryConfig,
  )
  runRestore(existingSuccess, existingBackup, 0)
  assertRecoveryConfigInstalled(existingSuccess, recoveryConfig)
  const existingSafety = safetyBackups(existingSuccess)
  assert.equal(existingSafety.length, 1)
  assert.equal(existsSync(backupConfigSnapshotPath(existingSafety[0])), false)
  assert.equal(verifyDatabase(existingSafety[0]).securityInvariants.emperorUsers, 1)
  assertNoRestoreTemporaryArtifacts(existingSuccess)

  // 损坏的旧 primary 只是回滚材料，不能阻断严格配对恢复。
  const invalidPrimary = prepareScenario("invalid-old-primary")
  const invalidPrimaryPaths = writeInstalledConfig(invalidPrimary, oldConfig)
  writeFileSync(invalidPrimaryPaths.primary, "setup: [\n", "utf8")
  writeFileSync(invalidPrimaryPaths.setupToken, "stale-token\n", "utf8")
  copyFileSync(templateDatabase, join(invalidPrimary, "data/recovered.db"))
  const invalidPrimaryBackup = createPairedBackup(
    invalidPrimary,
    templateDatabase,
    recoveryConfig,
  )
  runRestore(invalidPrimary, invalidPrimaryBackup, 0)
  assertRecoveryConfigInstalled(invalidPrimary, recoveryConfig)

  // 来源未满足恰一 Emperor 时必须在任何目标变更前失败，并逐字保留旧状态。
  const failed = prepareScenario("failed")
  const failedPaths = writeInstalledConfig(failed, oldConfig)
  writeFileSync(failedPaths.setupToken, "preserve-this-token\n", "utf8")
  const failedDestination = join(failed, "data/recovered.db")
  copyFileSync(templateDatabase, failedDestination)
  const beforeFailure = {
    primary: readFileSync(failedPaths.primary),
    lastKnownGood: readFileSync(failedPaths.lastKnownGood),
    setupToken: readFileSync(failedPaths.setupToken),
    databaseHash: sha256(failedDestination),
  }
  const failedBackup = createPairedBackup(
    failed,
    templateDatabase,
    recoveryConfig,
    { removeEmperor: true },
  )
  const failedResult = runRestore(failed, failedBackup, 1)
  assert.match(failedResult.stderr, /exactly one emperor user/)
  assert.deepEqual(readFileSync(failedPaths.primary), beforeFailure.primary)
  assert.deepEqual(readFileSync(failedPaths.lastKnownGood), beforeFailure.lastKnownGood)
  assert.deepEqual(readFileSync(failedPaths.setupToken), beforeFailure.setupToken)
  assert.equal(sha256(failedDestination), beforeFailure.databaseHash)
  assert.equal(safetyBackups(failed).length, 0)
  assertNoRestoreTemporaryArtifacts(failed)

  // 缺少应用必需列的来源必须在改动目标/config/token 之前被拒绝。
  const incompleteSchema = prepareScenario("incomplete-schema")
  const incompletePaths = writeInstalledConfig(incompleteSchema, oldConfig)
  writeFileSync(incompletePaths.setupToken, "preserve-schema-token\n", "utf8")
  const incompleteDestination = join(incompleteSchema, "data/recovered.db")
  copyFileSync(templateDatabase, incompleteDestination)
  const beforeIncomplete = {
    primary: readFileSync(incompletePaths.primary),
    lastKnownGood: readFileSync(incompletePaths.lastKnownGood),
    setupToken: readFileSync(incompletePaths.setupToken),
    databaseHash: sha256(incompleteDestination),
  }
  const incompleteBackup = createPairedBackup(
    incompleteSchema,
    templateDatabase,
    recoveryConfig,
    { dropMessageHtml: true },
  )
  const incompleteResult = runRestore(incompleteSchema, incompleteBackup, 1)
  assert.match(incompleteResult.stderr, /message is missing columns: html/)
  assert.deepEqual(readFileSync(incompletePaths.primary), beforeIncomplete.primary)
  assert.deepEqual(readFileSync(incompletePaths.lastKnownGood), beforeIncomplete.lastKnownGood)
  assert.deepEqual(readFileSync(incompletePaths.setupToken), beforeIncomplete.setupToken)
  assert.equal(sha256(incompleteDestination), beforeIncomplete.databaseHash)
  assertNoRestoreTemporaryArtifacts(incompleteSchema)

  const invalidPrimaryKey = prepareScenario("invalid-primary-key")
  const invalidPrimaryKeyPaths = writeInstalledConfig(invalidPrimaryKey, oldConfig)
  const invalidPrimaryKeyDestination = join(invalidPrimaryKey, "data/recovered.db")
  copyFileSync(templateDatabase, invalidPrimaryKeyDestination)
  const invalidPrimaryKeyHash = sha256(invalidPrimaryKeyDestination)
  const invalidPrimaryKeyBackup = createPairedBackup(
    invalidPrimaryKey,
    templateDatabase,
    recoveryConfig,
    { dropSiteConfigPrimaryKey: true },
  )
  const invalidPrimaryKeyResult = runRestore(
    invalidPrimaryKey,
    invalidPrimaryKeyBackup,
    1,
  )
  assert.match(invalidPrimaryKeyResult.stderr, /site_config primary key is invalid/)
  assert.equal(sha256(invalidPrimaryKeyDestination), invalidPrimaryKeyHash)
  assert.deepEqual(loadTrustedConfigFile(invalidPrimaryKeyPaths.primary), oldConfig)
  assert.deepEqual(loadTrustedConfigFile(invalidPrimaryKeyPaths.lastKnownGood), oldConfig)
  assertNoRestoreTemporaryArtifacts(invalidPrimaryKey)

  // lower(address) 必须是唯一且完整的 key expression，不能用拼接扩大表达式后绕过。
  assertInvalidLowerAddressIndexRejected(
    "invalid-lower-address-expression",
    "concatenated-expression",
    /email_address_lower_idx expression is invalid/,
  )

  // 同名唯一索引即使表达式正确，也不能用 WHERE 缩小唯一性覆盖范围。
  assertInvalidLowerAddressIndexRejected(
    "partial-lower-address-index",
    "partial",
    /email_address_lower_idx partial property is invalid/,
  )

  // 全新数据目录只需恢复点 pair；成功后安装 primary/LKG 且不制造 safety pair。
  const fresh = prepareScenario("fresh")
  const freshPaths = installedPaths(fresh)
  writeFileSync(freshPaths.setupToken, "fresh-setup-token\n", "utf8")
  const freshBackup = createPairedBackup(fresh, templateDatabase, recoveryConfig)
  runRestore(fresh, freshBackup, 0)
  assertRecoveryConfigInstalled(fresh, recoveryConfig)
  assert.equal(verifyDatabase(join(fresh, "data/recovered.db")).securityInvariants.emperorUsers, 1)
  assert.equal(safetyBackups(fresh).length, 0)
  assert.equal(existsSync(`${freshBackup}-wal`), false)
  assert.equal(existsSync(`${freshBackup}-shm`), false)
  assertNoRestoreTemporaryArtifacts(fresh)

  // 来源仍有活跃 WAL 时，restore 必须通过 SQLite Online Backup API 把已提交
  // marker 合并进独立快照，不能只复制 main file 静默丢数据。
  const walScenario = prepareScenario("wal-source")
  const walBackup = createPairedBackup(walScenario, templateDatabase, recoveryConfig)
  const walWriter = new Database(walBackup)
  try {
    walWriter.pragma("journal_mode = WAL")
    walWriter.pragma("wal_autocheckpoint = 0")
    walWriter.prepare(
      "INSERT OR REPLACE INTO site_config (key, value, updated_at) VALUES (?, ?, ?)",
    ).run("restore-wal-marker", "committed-in-wal", Date.now())
    assert.equal(existsSync(`${walBackup}-wal`), true)

    runRestore(walScenario, walBackup, 0)
    const restored = new Database(join(walScenario, "data/recovered.db"), {
      readonly: true,
    })
    try {
      const marker = restored.prepare(
        "SELECT value FROM site_config WHERE key = ?",
      ).get("restore-wal-marker") as { value: string } | undefined
      assert.equal(marker?.value, "committed-in-wal")
    } finally {
      restored.close()
    }
    assertNoRestoreTemporaryArtifacts(walScenario)
  } finally {
    walWriter.close()
  }

  console.log(JSON.stringify({
    existingDifferentConfigCommittedAfterVerify: true,
    invalidOldPrimaryDidNotBlockRecovery: true,
    failedRestorePreservedDatabaseConfigAndToken: true,
    incompleteSchemaRejectedBeforeMutation: true,
    invalidPrimaryKeyRejectedBeforeMutation: true,
    invalidLowerAddressExpressionRejectedBeforeMutation: true,
    partialLowerAddressIndexRejectedBeforeMutation: true,
    freshRestoreInstalledRecoveryPair: true,
    walSnapshotPreservedCommittedRows: true,
    setupTokenRemovedOnlyOnSuccess: true,
    localSafetyBackupRemainedUnpaired: true,
  }, null, 2))
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
