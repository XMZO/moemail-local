import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { parse } from "yaml"

const packageDocument = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts?: Record<string, string>
}

type ComposeService = {
  image?: string
  networks?: string[] | Record<string, unknown>
  ports?: unknown
  volumes?: Array<string | Record<string, unknown>>
}

type ComposeDocument = {
  services?: Record<string, ComposeService>
  networks?: Record<string, { internal?: boolean }>
}

function networkNames(service: ComposeService | undefined) {
  assert.ok(service, "Compose service is missing")
  if (Array.isArray(service.networks)) return service.networks
  return Object.keys(service.networks ?? {})
}

function baseImageMajor(path: string) {
  const source = readFileSync(path, "utf8")
  const match = /^FROM postgres:(\d+)-bookworm$/m.exec(source)
  assert.ok(match, `${path} must pin a postgres:<major>-bookworm base image`)
  return Number(match[1])
}

const compose = parse(readFileSync("compose.postgres.yaml", "utf8")) as ComposeDocument
const services = compose.services ?? {}

assert.equal(compose.networks?.database?.internal, true)
assert.deepEqual(networkNames(services.postgres), ["database"])
assert.equal(services.postgres?.ports, undefined, "PostgreSQL must not publish a host port")

for (const name of ["postgres-backup", "postgres-backup-scheduler", "postgres-restore"]) {
  const networks = new Set(networkNames(services[name]))
  assert.ok(networks.has("database"), `${name} cannot reach the built-in PostgreSQL service`)
  assert.ok(networks.has("default"), `${name} cannot reach an external PostgreSQL service`)
}
const postgresRestoreVolumes = services["postgres-restore"]?.volumes ?? []
assert.ok(
  postgresRestoreVolumes.includes("moemail-config:/app/data"),
  "postgres-restore must be able to atomically install or roll back runtime config",
)
assert.equal(
  postgresRestoreVolumes.includes("moemail-config:/app/data:ro"),
  false,
  "postgres-restore config volume must not be read-only",
)

assert.deepEqual(
  networkNames(services["offsite-backup"]),
  ["default"],
  "offsite-backup must not depend on database network access",
)

const serverMajor = baseImageMajor("deploy/docker/postgres.Dockerfile")
const toolsMajor = baseImageMajor("deploy/docker/postgres-tools.Dockerfile")
const toolsDockerfile = readFileSync("deploy/docker/postgres-tools.Dockerfile", "utf8")
assert.ok(
  toolsMajor >= serverMajor,
  `PostgreSQL tools major ${toolsMajor} is older than server major ${serverMajor}`,
)
for (const name of ["postgres-backup", "postgres-backup-scheduler", "postgres-restore"]) {
  assert.equal(services[name]?.image, `moemail-postgres-tools:${toolsMajor}`)
}
assert.match(toolsDockerfile, /\bca-certificates\b/)

const entrypoint = readFileSync("deploy/docker/postgres-entrypoint.sh", "utf8")
assert.match(entrypoint, /# moemail-compose-internal-trust/)
assert.match(entrypoint, /^host all all 0\.0\.0\.0\/0 trust$/m)
assert.match(entrypoint, /^host all all ::\/0 trust$/m)

const postgresBackup = readFileSync("deploy/docker/postgres-backup.sh", "utf8")
const postgresRestore = readFileSync("deploy/docker/postgres-restore.sh", "utf8")
const postgresBackupScheduler = readFileSync(
  "deploy/docker/postgres-backup-scheduler.sh",
  "utf8",
)
assert.match(postgresBackup, /expired_pair="\$\{expired\}\.config\.yaml\.lkg"/)
assert.match(postgresBackup, /expired_pair[\s\S]*validate-complete/)
assert.match(postgresBackup, /pair_driver.*database\.driver/)
assert.match(postgresBackup, /pair_configured_directory.*database\.postgres\.backupDir/)
assert.match(postgresBackup, /pg_export_snapshot\(\)/)
assert.match(postgresBackup, /--snapshot "\$database_snapshot"/)
assert.match(postgresBackup, /postgres-fields/)
assert.match(postgresBackup, /postgres-conninfo/)
assert.doesNotMatch(postgresBackup, /database_url/)
assert.match(postgresRestore, /postgres-fields/)
assert.match(postgresRestore, /postgres-conninfo/)
assert.doesNotMatch(postgresRestore, /database_url/)
assert.match(postgresRestore, /mv -T --/)
assert.match(postgresRestore, /cmp -s --/)
for (const [name, source] of [
  ["postgres-backup", postgresBackup],
  ["postgres-restore", postgresRestore],
  ["postgres-backup-scheduler", postgresBackupScheduler],
] as const) {
  assert.match(source, /PGSSLROOTCERT=system/, `${name} must use the system CA pool for verify-full`)
}
assert.match(postgresRestore, /install_recovery_config/)
assert.match(postgresRestore, /restore_previous_config/)
assert.doesNotMatch(postgresRestore, /installed_fingerprint|recovery_fingerprint/)
assert.doesNotMatch(postgresRestore, /safety_config/)

const dockerConfigReader = readFileSync("deploy/docker/config-reader.mjs", "utf8")
assert.match(dockerConfigReader, /command === "postgres-target"/)
assert.match(dockerConfigReader, /command === "postgres-fields"/)
assert.match(dockerConfigReader, /command === "postgres-conninfo"/)
assert.match(dockerConfigReader, /databaseUrl\.searchParams\.size > 0/)

for (const serviceFile of [
  "deploy/local/moemail.service",
  "deploy/local/moemail-scheduler.service",
]) {
  assert.match(readFileSync(serviceFile, "utf8"), /^Restart=always$/m)
}

const dockerEntrypoint = readFileSync("deploy/docker/entrypoint.sh", "utf8")
const webSystemdUnit = readFileSync("deploy/local/moemail.service", "utf8")
const instrumentation = readFileSync("instrumentation-node.ts", "utf8")
assert.equal(packageDocument.scripts?.prestart, undefined)
assert.doesNotMatch(dockerEntrypoint, /pnpm db:startup/)
assert.match(
  dockerEntrypoint,
  /restore\)\s*[\s\S]*?exec pnpm db:restore "\$@"/,
  "Docker restore must bootstrap from the backup pair without requiring an installed LKG",
)
assert.doesNotMatch(webSystemdUnit, /^ExecStartPre=.*db:startup$/m)
assert.match(instrumentation, /await awaitInitialConfigReady\(\)/)

console.log(JSON.stringify({
  postgresInternalNetworkOnly: true,
  postgresHostAuthenticationForInternalPeers: true,
  externalPostgresToolsReachable: true,
  postgresServerMajor: serverMajor,
  postgresToolsMajor: toolsMajor,
  postgresRetentionRequiresConfigPair: true,
  postgresVerificationAndDumpShareSnapshot: true,
  strictPostgresTlsUsesSystemCa: true,
  postgresTargetInspectionIsRedacted: true,
  postgresRestoreRollsBackDatabaseAndConfig: true,
  freshVolumeRestoreUsesBackupPair: true,
  systemdSuccessfulRestart: true,
  singleAuthoritativeWebStartupValidation: true,
}, null, 2))
