import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Client } from "pg"
import { postgresPoolConfig } from "../../app/lib/db"
import { writeConfigFile } from "../../app/lib/config/file"
import { createDefaultConfig } from "../../app/lib/config/schema"
import {
  removeBackupAndConfigSnapshot,
  writeBackupConfigSnapshot,
} from "../ops/backup-config-snapshot"
import {
  buildOffsiteArtifacts,
  isOffsiteDatabaseBackup,
} from "../ops/offsite-artifacts"
import { withTemporaryRcloneConfig } from "../ops/rclone-config"
import {
  backupConfigSnapshotPath,
  loadBackupConfigSnapshot,
} from "../ops/trusted-config"
import { libpqEnvironment } from "../postgres/archive"
import { findPrunablePostgresBackups } from "../postgres/backup-retention"
import {
  postgresTargetConninfo,
  resolveLibpqSslMode,
  resolvePostgresTarget,
} from "../postgres/libpq"
import { findPrunableSqliteBackups } from "../sqlite/backup-retention"

assert.equal(withTemporaryRcloneConfig(null, path => path), null)

const content = "[archive]\ntype = local\n"
let temporaryPath = ""
let temporaryDirectory = ""
const result = withTemporaryRcloneConfig(content, path => {
  assert.ok(path)
  temporaryPath = path
  temporaryDirectory = dirname(path)
  assert.equal(existsSync(path), true)
  assert.equal(readFileSync(path, "utf8"), content)
  return "callback-result"
})

assert.equal(result, "callback-result")
assert.equal(existsSync(temporaryPath), false)
assert.equal(existsSync(temporaryDirectory), false)

let failedDirectory = ""
assert.throws(() => withTemporaryRcloneConfig(content, path => {
  assert.ok(path)
  failedDirectory = dirname(path)
  throw new Error("expected validation failure")
}), /expected validation failure/)
assert.equal(existsSync(failedDirectory), false)

const artifacts = buildOffsiteArtifacts(
  "/app/data/backups/moemail-test.db",
  "archive:moemail/",
)
assert.equal(artifacts.length, 2)
assert.equal(artifacts[0].destination, "archive:moemail/moemail-test.db")
assert.equal(
  artifacts[1].destination,
  "archive:moemail/moemail-test.db.config.yaml.lkg",
)
assert.equal(isOffsiteDatabaseBackup("/backups/moemail-test.db", "sqlite"), true)
assert.equal(
  isOffsiteDatabaseBackup("/backups/pre-restore-test.db", "sqlite"),
  false,
)
assert.equal(isOffsiteDatabaseBackup("/backups/moemail-test.dump", "postgres"), true)
assert.equal(
  isOffsiteDatabaseBackup("/backups/pre-restore-test.dump", "postgres"),
  false,
)
assert.equal(
  artifacts[1].source,
  "/app/data/backups/moemail-test.db.config.yaml.lkg",
)

const validationRoot = mkdtempSync(join(tmpdir(), "moemail-backup-artifacts-"))
try {
  const defaults = createDefaultConfig()
  const config = {
    ...defaults,
    setup: { completed: true, completedAt: "2026-08-11T00:00:00.000Z" },
    database: {
      ...defaults.database,
      driver: "postgres" as const,
      postgres: {
        ...defaults.database.postgres,
        url: "postgresql://moemail:secret@postgres/moemail",
        ssl: true,
        sslRejectUnauthorized: true,
      },
    },
    auth: {
      ...defaults.auth,
      secret: "auth-secret-abcdefghijklmnopqrstuvwxyz-0123456789",
      passwordPepper: "password-pepper-abcdefghijklmnopqrstuvwxyz-0123456789",
    },
    email: {
      ...defaults.email,
      ingestSecret: "ingest-secret-abcdefghijklmnopqrstuvwxyz-0123456789",
    },
  }
  const backupPath = join(validationRoot, "moemail-test.dump")
  writeFileSync(backupPath, "database backup", "utf8")
  const pairedPath = writeBackupConfigSnapshot(backupPath, config)
  assert.equal(pairedPath, backupConfigSnapshotPath(backupPath))
  assert.deepEqual(loadBackupConfigSnapshot(backupPath), config)
  assert.throws(
    () => writeBackupConfigSnapshot(backupPath, config),
    /already exists/,
  )
  assert.equal(readFileSync(backupPath, "utf8"), "database backup")
  assert.equal(existsSync(pairedPath), true)

  assert.deepEqual(resolveLibpqSslMode({
    ...config.database.postgres,
    ssl: false,
  }), { mode: "disable", source: "yaml" })
  assert.deepEqual(resolveLibpqSslMode({
    ...config.database.postgres,
    ssl: true,
    sslRejectUnauthorized: false,
  }), { mode: "require", source: "yaml" })
  assert.deepEqual(resolveLibpqSslMode(config.database.postgres), {
    mode: "verify-full",
    source: "yaml",
  })
  assert.deepEqual(resolvePostgresTarget(config.database.postgres), {
    host: "postgres",
    port: "5432",
    database: "moemail",
    user: "moemail",
  })
  process.env.PG_UNRELATED_TEST_VALUE = "must-not-leak"
  process.env.PGSSLROOTCERT = "must-not-leak"
  const libpqEnv = libpqEnvironment(config)
  delete process.env.PG_UNRELATED_TEST_VALUE
  delete process.env.PGSSLROOTCERT
  assert.equal(libpqEnv.PG_UNRELATED_TEST_VALUE, undefined)
  assert.equal(libpqEnv.PGSSLMODE, "verify-full")
  assert.equal(libpqEnv.PGSSLROOTCERT, "system")

  process.env.PGHOST = "environment-host.invalid"
  process.env.PGPORT = "6543"
  process.env.PGUSER = "environment-user"
  process.env.PGPASSWORD = "environment-password"
  process.env.PGDATABASE = "environment-database"
  process.env.PGSSLMODE = "disable"
  process.env.PGOPTIONS = "-c search_path=environment_schema"
  process.env.PGCLIENTENCODING = "LATIN1"
  process.env.PGREPLICATION = "database"
  process.env.PGBINARY = "1"
  const nodeClient = new Client(postgresPoolConfig(config))
  const nodeParameters = (nodeClient as unknown as {
    connectionParameters: {
      host: string
      port: number
      user: string
      database: string
      ssl: unknown
      options: string
      client_encoding: string
      replication: string
      password: string | (() => Promise<string> | string)
    }
  }).connectionParameters
  for (const key of [
    "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "PGSSLMODE",
    "PGOPTIONS", "PGCLIENTENCODING", "PGREPLICATION", "PGBINARY",
  ]) assert.equal(process.env[key], undefined, `${key} must be discarded`)
  assert.equal(nodeParameters.host, "postgres")
  assert.equal(nodeParameters.port, 5432)
  assert.equal(nodeParameters.user, "moemail")
  assert.equal(nodeParameters.database, "moemail")
  assert.deepEqual(nodeParameters.ssl, { rejectUnauthorized: true })
  assert.equal(nodeParameters.options, " ")
  assert.equal(nodeParameters.client_encoding, "UTF8")
  assert.equal(nodeParameters.replication, "false")
  assert.equal(
    await (nodeParameters.password as () => Promise<string> | string)(),
    "secret",
  )
  const noTlsClient = new Client(postgresPoolConfig({
    ...config,
    database: {
      ...config.database,
      postgres: { ...config.database.postgres, ssl: false },
    },
  }))
  assert.equal(
    (noTlsClient as unknown as { connectionParameters: { ssl: unknown } })
      .connectionParameters.ssl,
    false,
  )

  const unusualDatabaseConfig = {
    ...config.database.postgres,
    url: "postgresql://moemail:secret@safehost/a%2Fb%3Dc%20host%3Devil",
  }
  assert.deepEqual(resolvePostgresTarget(unusualDatabaseConfig), {
    host: "safehost",
    port: "5432",
    database: "a/b=c host=evil",
    user: "moemail",
  })
  assert.equal(
    postgresTargetConninfo(unusualDatabaseConfig),
    "host='safehost' port='5432' user='moemail' dbname='a/b=c host=evil'",
  )
  assert.throws(
    () => resolvePostgresTarget({
      ...config.database.postgres,
      url: "postgresql://moemail@%31%32%37.0.0.1/moemail",
    }),
    /host must not contain percent-encoding/,
  )
  assert.throws(
    () => resolvePostgresTarget({
      ...config.database.postgres,
      url: " postgresql://moemail@postgres/moemail ",
    }),
    /percent-encode whitespace/,
  )
  const ipv6Config = {
    ...config,
    database: {
      ...config.database,
      postgres: {
        ...config.database.postgres,
        url: "postgresql://moemail:ipv6-secret@[2001:db8::1]:6432/moemail",
      },
    },
  }
  const ipv6Environment = libpqEnvironment(ipv6Config)
  assert.equal(ipv6Environment.PGHOST, "2001:db8::1")
  assert.equal(ipv6Environment.PGPORT, "6432")
  assert.equal(ipv6Environment.PGDATABASE, "moemail")
  const queryOverrideConfig = {
    ...config,
    database: {
      ...config.database,
      postgres: {
        ...config.database.postgres,
        url: `${config.database.postgres.url}?host=other.example.test`,
      },
    },
  }
  assert.throws(
    () => resolveLibpqSslMode(queryOverrideConfig.database.postgres),
    /query parameters are not allowed/,
  )

  const dockerConfigPath = join(validationRoot, "docker-config.yaml.lkg")
  writeConfigFile(dockerConfigPath, queryOverrideConfig)
  const configReader = resolve(process.cwd(), "deploy/docker/config-reader.mjs")
  const rejectedDockerSsl = spawnSync(process.execPath, [
    configReader,
    "--file",
    dockerConfigPath,
    "postgres-sslmode",
  ], { encoding: "utf8" })
  assert.equal(rejectedDockerSsl.status, 65)
  assert.match(rejectedDockerSsl.stderr, /query parameters are not allowed/)

  writeConfigFile(dockerConfigPath, config)
  const dockerSsl = spawnSync(process.execPath, [
    configReader,
    "--file",
    dockerConfigPath,
    "postgres-sslmode",
  ], { encoding: "utf8" })
  assert.equal(dockerSsl.status, 0, dockerSsl.stderr)
  assert.equal(dockerSsl.stdout, "verify-full")
  const dockerSslSource = spawnSync(process.execPath, [
    configReader,
    "--file",
    dockerConfigPath,
    "postgres-sslmode-source",
  ], { encoding: "utf8" })
  assert.equal(dockerSslSource.status, 0, dockerSslSource.stderr)
  assert.equal(dockerSslSource.stdout, "yaml")
  const dockerTarget = spawnSync(process.execPath, [
    configReader,
    "--file",
    dockerConfigPath,
    "postgres-target",
  ], { encoding: "utf8" })
  assert.equal(dockerTarget.status, 0, dockerTarget.stderr)
  assert.deepEqual(JSON.parse(dockerTarget.stdout), {
    host: "postgres",
    port: "5432",
    database: "moemail",
    user: "moemail",
    tlsMode: "verify-full",
  })
  assert.doesNotMatch(`${dockerTarget.stdout}\n${dockerTarget.stderr}`, /secret/)
  const unusualDockerConfig = {
    ...config,
    database: {
      ...config.database,
      postgres: unusualDatabaseConfig,
    },
  }
  writeConfigFile(dockerConfigPath, unusualDockerConfig)
  const dockerConninfo = spawnSync(process.execPath, [
    configReader,
    "--file",
    dockerConfigPath,
    "postgres-conninfo",
  ], { encoding: "utf8" })
  assert.equal(dockerConninfo.status, 0, dockerConninfo.stderr)
  assert.equal(
    dockerConninfo.stdout,
    "host='safehost' port='5432' user='moemail' dbname='a/b=c host=evil'",
  )
  const dockerFields = spawnSync(process.execPath, [
    configReader,
    "--file",
    dockerConfigPath,
    "postgres-fields",
  ])
  assert.equal(dockerFields.status, 0, dockerFields.stderr.toString("utf8"))
  assert.deepEqual(
    dockerFields.stdout,
    Buffer.from("safehost\0" + "5432\0" + "moemail\0" + "secret\0" + "a/b=c host=evil\0"),
  )
  writeConfigFile(dockerConfigPath, {
    ...config,
    database: {
      ...config.database,
      postgres: {
        ...config.database.postgres,
        url: "postgresql://moemail@%31%32%37.0.0.1/moemail",
      },
    },
  })
  const rejectedEncodedHost = spawnSync(process.execPath, [
    configReader,
    "--file",
    dockerConfigPath,
    "validate-complete",
  ], { encoding: "utf8" })
  assert.equal(rejectedEncodedHost.status, 65)
  writeConfigFile(dockerConfigPath, config)
  const completeDockerSnapshot = spawnSync(process.execPath, [
    configReader,
    "--file",
    dockerConfigPath,
    "validate-complete",
  ], { encoding: "utf8" })
  assert.equal(completeDockerSnapshot.status, 0, completeDockerSnapshot.stderr)
  assert.equal(completeDockerSnapshot.stdout, "ok")

  const truncatedDockerPair = join(validationRoot, "truncated-pair.config.yaml.lkg")
  writeFileSync(
    truncatedDockerPair,
    "setup:\n  completed: true\ndatabase:\n  driver: postgres\n  postgres:\n    backupDir: data/postgres-backups\n",
    "utf8",
  )
  const rejectedTruncatedSnapshot = spawnSync(process.execPath, [
    configReader,
    "--file",
    truncatedDockerPair,
    "validate-complete",
  ], { encoding: "utf8" })
  assert.equal(rejectedTruncatedSnapshot.status, 65)
  assert.match(rejectedTruncatedSnapshot.stderr, /不完整或不符合当前 schema/)

  const retentionRoot = join(validationRoot, "retention")
  const retentionData = join(retentionRoot, "data")
  mkdirSync(retentionData, { recursive: true })
  const retentionConfig = {
    ...config,
    database: {
      ...config.database,
      driver: "sqlite" as const,
      sqlite: {
        ...config.database.sqlite,
        path: "data/moemail-prod.db",
        backupDir: "data",
      },
    },
  }
  const liveDatabase = join(retentionData, "moemail-prod.db")
  const archivedDatabase = join(retentionData, "moemail-archive.db")
  const currentDestination = join(retentionData, "moemail-current.db")
  const hardLinkToLiveDatabase = join(retentionData, "moemail-live-hardlink.db")
  const missingPairDatabase = join(retentionData, "moemail-no-pair.db")
  const malformedPairDatabase = join(retentionData, "moemail-malformed-pair.db")
  for (const path of [
    liveDatabase,
    archivedDatabase,
    currentDestination,
    missingPairDatabase,
    malformedPairDatabase,
  ]) {
    writeFileSync(path, "sqlite", "utf8")
  }
  linkSync(liveDatabase, hardLinkToLiveDatabase)
  for (const path of [
    liveDatabase,
    archivedDatabase,
    currentDestination,
    hardLinkToLiveDatabase,
  ]) {
    writeBackupConfigSnapshot(path, retentionConfig)
  }
  writeFileSync(
    backupConfigSnapshotPath(malformedPairDatabase),
    "setup: [broken-yaml",
    "utf8",
  )
  const oldTime = new Date(Date.now() - 90 * 86_400_000)
  for (const path of [
    liveDatabase,
    archivedDatabase,
    currentDestination,
    hardLinkToLiveDatabase,
    missingPairDatabase,
    malformedPairDatabase,
  ]) {
    utimesSync(path, oldTime, oldTime)
  }

  const prunable = findPrunableSqliteBackups({
    backupDirectory: retentionData,
    source: liveDatabase,
    destination: currentDestination,
    retentionCutoff: Date.now() - 30 * 86_400_000,
    workingDirectory: retentionRoot,
  })
  assert.deepEqual(prunable, [archivedDatabase])
  for (const path of prunable) removeBackupAndConfigSnapshot(path)
  assert.equal(existsSync(liveDatabase), true)
  assert.equal(existsSync(hardLinkToLiveDatabase), true)
  assert.equal(existsSync(currentDestination), true)
  assert.equal(existsSync(missingPairDatabase), true)
  assert.equal(existsSync(malformedPairDatabase), true)
  assert.equal(existsSync(archivedDatabase), false)

  const postgresRetentionDirectory = join(
    retentionRoot,
    "data",
    "postgres-backups",
  )
  mkdirSync(postgresRetentionDirectory, { recursive: true })
  const postgresArchive = join(postgresRetentionDirectory, "moemail-archive.dump")
  const postgresSafety = join(postgresRetentionDirectory, "pre-restore-safety.dump")
  const postgresCurrent = join(postgresRetentionDirectory, "moemail-current.dump")
  const postgresUnpaired = join(postgresRetentionDirectory, "moemail-unpaired.dump")
  const postgresMalformed = join(postgresRetentionDirectory, "moemail-malformed.dump")
  for (const path of [
    postgresArchive,
    postgresSafety,
    postgresCurrent,
    postgresUnpaired,
    postgresMalformed,
  ]) {
    writeFileSync(path, "postgres", "utf8")
    utimesSync(path, oldTime, oldTime)
  }
  for (const path of [postgresArchive, postgresSafety, postgresCurrent]) {
    writeBackupConfigSnapshot(path, config)
  }
  writeFileSync(
    backupConfigSnapshotPath(postgresMalformed),
    "setup: [broken-yaml",
    "utf8",
  )
  const postgresPrunable = findPrunablePostgresBackups({
    backupDirectory: postgresRetentionDirectory,
    destination: postgresCurrent,
    retentionCutoff: Date.now() - 30 * 86_400_000,
    workingDirectory: retentionRoot,
  })
  assert.deepEqual(postgresPrunable.sort(), [postgresArchive, postgresSafety].sort())
  assert.equal(postgresPrunable.includes(postgresUnpaired), false)
  assert.equal(postgresPrunable.includes(postgresMalformed), false)

  removeBackupAndConfigSnapshot(backupPath)
  assert.equal(existsSync(backupPath), false)
  assert.equal(existsSync(pairedPath), false)
} finally {
  rmSync(validationRoot, { recursive: true, force: true })
}

console.log(JSON.stringify({
  rcloneConfigOnlyExistsDuringInvocation: true,
  temporaryConfigRemovedAfterSuccess: true,
  temporaryConfigRemovedAfterFailure: true,
  offsiteIncludesValidatedConfigSnapshot: true,
  offsiteExcludesPreRestoreSafetyBackups: true,
  databaseBackupAndConfigArePaired: true,
  recoveryUsesPairedConfigAsAuthority: true,
  libpqTlsDerivedFromYaml: true,
  inheritedLibpqEnvironmentIgnored: true,
  postgresUrlQueriesRejected: true,
  postgresTargetIsExplicitAndRedacted: true,
  libpqUsesSystemCaForStrictTls: true,
  libpqIpv6HostNormalized: true,
  sqliteRetentionNeverDeletesLiveDatabase: true,
  postgresRetentionRequiresValidatedConfigPair: true,
  dockerRetentionRejectsTruncatedConfigPair: true,
}, null, 2))
