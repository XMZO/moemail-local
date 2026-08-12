import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse, stringify } from "yaml"
import { createDefaultConfig } from "../../app/lib/config/schema"

const packageDocument = JSON.parse(readFileSync("package.json", "utf8")) as {
  version?: string
  packageManager?: string
  scripts?: Record<string, string>
}

assert.match(packageDocument.version ?? "", /^\d+\.\d+\.\d+$/)
assert.equal(packageDocument.packageManager, "pnpm@11.21.0")
const composeImageTag = "latest"

type Healthcheck = {
  disable?: boolean
}

type DependsOn = Record<string, { condition?: string }>

type ComposeService = {
  "<<"?: ComposeService | ComposeService[]
  image?: string
  pull_policy?: string
  build?: unknown
  user?: string
  restart?: string
  networks?: string[] | Record<string, unknown>
  network_mode?: string
  ports?: unknown[]
  volumes?: string[]
  profiles?: string[]
  command?: string[]
  entrypoint?: string[]
  depends_on?: DependsOn
  read_only?: boolean
  tmpfs?: string[]
  cap_drop?: string[]
  cap_add?: string[]
  security_opt?: string[]
  stop_grace_period?: string
  healthcheck?: Healthcheck
}

type ComposeDocument = {
  name?: string
  services?: Record<string, ComposeService>
  networks?: Record<string, { internal?: boolean }>
  volumes?: Record<string, unknown>
}

type WorkflowDocument = {
  on?: Record<string, unknown>
}

function resolveService(service: ComposeService | undefined) {
  assert.ok(service, "Compose service is missing")
  const inherited = service["<<"]
  const bases = inherited ? (Array.isArray(inherited) ? inherited : [inherited]) : []
  return Object.assign({}, ...bases, service) as ComposeService
}

function networkNames(service: ComposeService | undefined) {
  const resolved = resolveService(service)
  if (Array.isArray(resolved.networks)) return resolved.networks
  return Object.keys(resolved.networks ?? {})
}

function serviceVolumes(service: ComposeService | undefined) {
  return resolveService(service).volumes ?? []
}

function dependencyCondition(service: ComposeService | undefined, dependency: string) {
  return resolveService(service).depends_on?.[dependency]?.condition
}

function baseImageMajor(path: string) {
  const source = readFileSync(path, "utf8")
  const match = /^FROM postgres:(\d+)-bookworm$/m.exec(source)
  assert.ok(match, `${path} must pin a postgres:<major>-bookworm base image`)
  return Number(match[1])
}

function sorted<T>(items: Iterable<T>) {
  return [...items].sort()
}

function parseCompose(path: string) {
  const source = readFileSync(path, "utf8")
  const compose = parse(source) as ComposeDocument
  const rawServices = compose.services ?? {}
  const services = Object.fromEntries(
    Object.entries(rawServices).map(([name, service]) => [name, resolveService(service)]),
  ) as Record<string, ComposeService>
  return { source, compose, services }
}

assert.equal(existsSync("compose.yml"), true)
assert.equal(existsSync("compose.postgres.yml"), true)
assert.equal(existsSync("compose.yaml"), false, "legacy compose.yaml must be removed")
assert.equal(existsSync("compose.postgres.yaml"), false, "legacy compose.postgres.yaml must be removed")
assert.equal(existsSync("deploy/docker/Caddyfile"), false, "Docker must not bundle Caddy")

const sqlite = parseCompose("compose.yml")
const sqliteServices = sqlite.services
assert.equal(sqlite.compose.name, "moemail")
assert.equal(sqlite.compose.volumes, undefined, "SQLite compose must use bind mounts")
assert.equal(sqlite.compose.networks, undefined, "SQLite compose must not define a PostgreSQL network")
assert.doesNotMatch(sqlite.source, /\$\{[^}]+\}/, "SQLite compose must not interpolate shell values")
assert.doesNotMatch(sqlite.source, /^\s*(?:environment|env_file|build):/m)
assert.deepEqual(
  sorted(Object.keys(sqliteServices)),
  sorted([
    "storage-init",
    "moemail",
    "cleanup",
    "backup",
    "restore",
    "scheduler",
    "monitor",
    "offsite-backup",
  ]),
)
assert.equal(sqliteServices.postgres, undefined)
assert.equal(sqliteServices["postgres-backup"], undefined)
assert.equal(sqliteServices["postgres-backup-scheduler"], undefined)
assert.equal(sqliteServices["postgres-restore"], undefined)
assert.doesNotMatch(sqlite.source, /moemail-local-postgres(?:-tools)?/)

for (const name of Object.keys(sqliteServices)) {
  assert.equal(sqliteServices[name]?.image, `ghcr.io/xmzo/moemail-local:${composeImageTag}`)
  assert.equal(sqliteServices[name]?.pull_policy, "always")
  assert.equal(sqliteServices[name]?.build, undefined)
}
assert.equal(sqliteServices["storage-init"]?.user, "0:0")
assert.equal(sqliteServices["storage-init"]?.network_mode, "none")
assert.deepEqual(serviceVolumes(sqliteServices["storage-init"]), ["./data:/app/data"])
assert.match(
  (sqliteServices["storage-init"]?.entrypoint ?? []).join("\n"),
  /install -d -o 10001 -g 10001 -m 0700 \/app\/data \/app\/data\/backups/,
)
assert.deepEqual(serviceVolumes(sqliteServices.moemail), ["./data:/app/data"])
assert.deepEqual(sqliteServices.moemail?.ports, ["127.0.0.1:3000:3000"])
assert.equal(dependencyCondition(sqliteServices.moemail, "storage-init"), "service_completed_successfully")
for (const name of ["cleanup", "backup"] as const) {
  assert.deepEqual(sqliteServices[name]?.profiles, ["maintenance"])
  assert.equal(sqliteServices[name]?.restart, "no")
  assert.equal(sqliteServices[name]?.healthcheck?.disable, true)
}
assert.deepEqual(sqliteServices.restore?.profiles, ["restore"])
assert.equal(sqliteServices.restore?.restart, "no")
assert.deepEqual(sqliteServices.restore?.entrypoint, ["/app/deploy/docker/entrypoint.sh", "restore"])
assert.deepEqual(sqliteServices.restore?.command, [])
assert.equal(sqliteServices.restore?.healthcheck?.disable, true)
assert.deepEqual(sqliteServices.scheduler?.profiles, ["scheduler"])
assert.equal(dependencyCondition(sqliteServices.scheduler, "moemail"), "service_healthy")
assert.deepEqual(sqliteServices.monitor?.profiles, ["monitoring"])
assert.equal(sqliteServices.monitor?.network_mode, "service:moemail")
assert.equal(sqliteServices.monitor?.user, "10001:10001")
assert.deepEqual(serviceVolumes(sqliteServices.monitor), ["./data:/app/data:ro"])
assert.deepEqual(sqliteServices.monitor?.cap_drop, ["ALL"])
assert.equal(sqliteServices.monitor?.cap_add, undefined)
assert.deepEqual(sqliteServices["offsite-backup"]?.profiles, ["offsite"])
assert.deepEqual(serviceVolumes(sqliteServices["offsite-backup"]), ["./data:/app/data:ro"])

const postgresCompose = parseCompose("compose.postgres.yml")
const postgresServices = postgresCompose.services
assert.equal(postgresCompose.compose.name, "moemail")
assert.equal(postgresCompose.compose.volumes, undefined, "PostgreSQL compose must use bind mounts")
assert.equal(postgresCompose.compose.networks?.database?.internal, true)
assert.doesNotMatch(postgresCompose.source, /\$\{[^}]+\}/, "PostgreSQL compose must not interpolate shell values")
assert.doesNotMatch(postgresCompose.source, /^\s*(?:environment|env_file|build):/m)
assert.deepEqual(
  sorted(Object.keys(postgresServices)),
  sorted([
    "storage-init",
    "postgres",
    "moemail",
    "cleanup",
    "postgres-backup",
    "scheduler",
    "postgres-backup-scheduler",
    "monitor",
    "offsite-backup",
    "postgres-restore",
  ]),
)
assert.equal(postgresServices.caddy, undefined)
assert.equal(postgresServices.backup, undefined, "PostgreSQL compose must not expose the SQLite-only backup wrapper")

for (const name of [
  "storage-init",
  "moemail",
  "cleanup",
  "scheduler",
  "monitor",
  "offsite-backup",
]) {
  assert.equal(postgresServices[name]?.image, `ghcr.io/xmzo/moemail-local:${composeImageTag}`)
  assert.equal(postgresServices[name]?.pull_policy, "always")
  assert.equal(postgresServices[name]?.build, undefined)
}
assert.equal(postgresServices.postgres?.image, `ghcr.io/xmzo/moemail-local-postgres:${composeImageTag}`)
assert.equal(postgresServices.postgres?.pull_policy, "always")
for (const name of ["postgres-backup", "postgres-backup-scheduler", "postgres-restore"]) {
  assert.equal(postgresServices[name]?.image, `ghcr.io/xmzo/moemail-local-postgres-tools:${composeImageTag}`)
  assert.equal(postgresServices[name]?.pull_policy, "always")
  assert.equal(postgresServices[name]?.user, "10001:10001")
}

assert.equal(postgresServices["storage-init"]?.user, "0:0")
assert.equal(postgresServices["storage-init"]?.network_mode, "none")
assert.deepEqual(serviceVolumes(postgresServices["storage-init"]), [
  "./data:/app/data",
  "./data/postgres:/postgres-data",
  "./data/postgres-backups:/backups",
])
assert.deepEqual(networkNames(postgresServices.postgres), ["database"])
assert.equal(postgresServices.postgres?.ports, undefined)
assert.deepEqual(serviceVolumes(postgresServices.postgres), ["./data/postgres:/var/lib/postgresql"])
assert.equal(dependencyCondition(postgresServices.postgres, "storage-init"), "service_completed_successfully")
assert.deepEqual(networkNames(postgresServices.moemail), ["default", "database"])
assert.equal(dependencyCondition(postgresServices.moemail, "postgres"), "service_healthy")
assert.deepEqual(serviceVolumes(postgresServices.moemail), ["./data:/app/data"])
assert.deepEqual(postgresServices.cleanup?.profiles, ["maintenance"])
assert.equal(postgresServices.cleanup?.restart, "no")
for (const name of ["postgres-backup", "postgres-backup-scheduler", "postgres-restore"]) {
  const networks = new Set(networkNames(postgresServices[name]))
  assert.ok(networks.has("database"), `${name} cannot reach built-in PostgreSQL`)
  assert.ok(networks.has("default"), `${name} cannot reach external PostgreSQL`)
}
assert.deepEqual(serviceVolumes(postgresServices["postgres-backup"]), [
  "./data:/app/data:ro",
  "./data/postgres-backups:/app/data/postgres-backups",
  "./data/postgres-backups:/backups",
])
assert.deepEqual(serviceVolumes(postgresServices["postgres-backup-scheduler"]), [
  "./data:/app/data:ro",
  "./data/postgres-backups:/app/data/postgres-backups",
  "./data/postgres-backups:/backups",
])
assert.deepEqual(serviceVolumes(postgresServices["postgres-restore"]), [
  "./data:/app/data",
  "./data/postgres-backups:/app/data/postgres-backups",
  "./data/postgres-backups:/backups",
])
assert.deepEqual(serviceVolumes(postgresServices.monitor), [
  "./data:/app/data:ro",
  "./data/postgres:/postgres-data:ro",
])
assert.deepEqual(postgresServices.monitor?.cap_add, ["DAC_READ_SEARCH"])
assert.deepEqual(serviceVolumes(postgresServices["offsite-backup"]), [
  "./data:/app/data:ro",
  "./data/postgres-backups:/app/data/postgres-backups:ro",
  "./data/postgres-backups:/backups:ro",
])

const serverMajor = baseImageMajor("deploy/docker/postgres.Dockerfile")
const toolsMajor = baseImageMajor("deploy/docker/postgres-tools.Dockerfile")
const toolsDockerfile = readFileSync("deploy/docker/postgres-tools.Dockerfile", "utf8")
assert.equal(serverMajor, 18)
assert.equal(toolsMajor, 18)
assert.match(toolsDockerfile, /\bca-certificates\b/)

const postgresEntrypoint = readFileSync("deploy/docker/postgres-entrypoint.sh", "utf8")
assert.match(postgresEntrypoint, /^data_root=\/var\/lib\/postgresql$/m)
assert.match(postgresEntrypoint, /^data_directory=\/var\/lib\/postgresql\/18\/docker$/m)
assert.match(postgresEntrypoint, /# moemail-compose-internal-trust/)
assert.match(postgresEntrypoint, /^host all all 0\.0\.0\.0\/0 trust$/m)
assert.match(postgresEntrypoint, /^host all all ::\/0 trust$/m)

const postgresBackup = readFileSync("deploy/docker/postgres-backup.sh", "utf8")
const postgresRestore = readFileSync("deploy/docker/postgres-restore.sh", "utf8")
const postgresBackupScheduler = readFileSync("deploy/docker/postgres-backup-scheduler.sh", "utf8")
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
  assert.match(source, /PGSSLROOTCERT=system/, `${name} must use the system CA pool`)
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

const configReaderFixtureRoot = mkdtempSync(join(tmpdir(), "moemail-config-reader-"))
try {
  const defaults = createDefaultConfig()
  const completeConfig = {
    ...defaults,
    setup: { completed: true, completedAt: "2026-08-12T00:00:00.000Z" },
    auth: {
      ...defaults.auth,
      secret: "reader-auth-secret-abcdefghijklmnopqrstuvwxyz-1234",
      passwordPepper: "reader-password-pepper-abcdefghijklmnopqrstuvwxyz",
    },
    email: {
      ...defaults.email,
      ingestSecret: "reader-ingest-secret-abcdefghijklmnopqrstuvwxyz-12",
    },
  }
  const validPath = join(configReaderFixtureRoot, "valid.yaml")
  writeFileSync(validPath, stringify(completeConfig, { lineWidth: 0 }), "utf8")
  assert.equal(execFileSync(process.execPath, [
    "deploy/docker/config-reader.mjs", "--file", validPath, "validate-complete",
  ], { encoding: "utf8" }), "ok")

  const invalidPath = join(configReaderFixtureRoot, "invalid-email.yaml")
  writeFileSync(invalidPath, stringify({
    ...completeConfig,
    email: {
      ...completeConfig.email,
      unknown: true,
    },
  }, { lineWidth: 0 }), "utf8")
  assert.throws(() => execFileSync(process.execPath, [
    "deploy/docker/config-reader.mjs", "--file", invalidPath, "validate-complete",
  ], { stdio: "pipe" }))
} finally {
  rmSync(configReaderFixtureRoot, { recursive: true, force: true })
}

for (const serviceFile of ["deploy/local/moemail.service", "deploy/local/moemail-scheduler.service"]) {
  assert.match(readFileSync(serviceFile, "utf8"), /^Restart=always$/m)
}

const dockerEntrypoint = readFileSync("deploy/docker/entrypoint.sh", "utf8")
const webSystemdUnit = readFileSync("deploy/local/moemail.service", "utf8")
const instrumentation = readFileSync("instrumentation-node.ts", "utf8")
assert.equal(packageDocument.scripts?.prestart, undefined)
assert.doesNotMatch(dockerEntrypoint, /pnpm db:startup/)
assert.doesNotMatch(dockerEntrypoint, /smtp-server|smtp:server/)
assert.match(
  dockerEntrypoint,
  /restore\)\s*[\s\S]*?exec pnpm db:restore "\$@"/,
  "Docker restore must bootstrap from the backup pair",
)
assert.doesNotMatch(webSystemdUnit, /^ExecStartPre=.*db:startup$/m)
assert.match(instrumentation, /await awaitInitialConfigReady\(\)/)

const workflowSource = readFileSync(".github/workflows/publish-docker.yml", "utf8")
const workflow = parse(workflowSource) as WorkflowDocument
assert.deepEqual(sorted(Object.keys(workflow.on ?? {})), ["push", "workflow_dispatch"])
assert.match(workflowSource, /push:\s+tags:\s+- '\*'/m)
assert.match(workflowSource, /publish_tag:/)
assert.match(workflowSource, /default:\s+latest/)
assert.doesNotMatch(workflowSource, /pull_request:|schedule:|branches:/)
assert.match(workflowSource, /packages: write/)
assert.match(workflowSource, /runner:\s+ubuntu-24\.04(?:\s|$)/m)
assert.match(workflowSource, /runner:\s+ubuntu-24\.04-arm/m)
assert.match(workflowSource, /platform:\s+linux\/amd64/m)
assert.match(workflowSource, /platform:\s+linux\/arm64/m)
assert.match(workflowSource, /expected_uname:\s+x86_64/m)
assert.match(workflowSource, /expected_uname:\s+aarch64/m)
assert.match(workflowSource, /uname -m/)
assert.doesNotMatch(workflowSource, /setup-qemu-action|qemu/i)
assert.match(workflowSource, /push-by-digest=true/)
assert.match(workflowSource, /Smoke-test native image/)
assert.match(workflowSource, /docker image inspect --format/)
assert.match(workflowSource, /docker run --rm --entrypoint/)
assert.match(workflowSource, /pg_isready --host 127\.0\.0\.1 --username moemail --dbname moemail/)
assert.match(workflowSource, /cat \/var\/lib\/postgresql\/18\/docker\/PG_VERSION/)
assert.match(workflowSource, /server_version_num'[)]::integer \/ 10000 = 18/)
assert.match(workflowSource, /Verify release tag matches package version/)
assert.match(workflowSource, /pnpm validate:email-worker/)
assert.match(workflowSource, /pnpm validate:mail-policies/)
assert.match(workflowSource, /pnpm validate:imap-inbound/)
assert.match(workflowSource, /pnpm validate:runtime-fields/)
assert.match(workflowSource, /pnpm validate:no-local-env/)
assert.match(workflowSource, /pnpm validate:deployment/)
assert.match(workflowSource, /pnpm exec tsc --noEmit --incremental false/)
assert.match(workflowSource, /build:\s+needs:\s+- prepare\s+- preflight/m)
assert.match(workflowSource, /docker buildx imagetools create/)
assert.match(workflowSource, /Expected exactly 2 native digests/)
assert.match(
  workflowSource,
  /name: digests-\$\{\{ matrix\.image_kind \}\}--\$\{\{ matrix\.expected_uname \}\}/,
  "digest artifact names must delimit postgres from postgres-tools",
)
assert.match(
  workflowSource,
  /pattern: digests-\$\{\{ matrix\.image_kind \}\}--\*/,
  "digest artifact patterns must not match another image kind by prefix",
)
assert.match(workflowSource, /linux\/amd64/)
assert.match(workflowSource, /linux\/arm64/)
assert.match(workflowSource, /ghcr\.io\/xmzo\/moemail-local"/)
assert.match(workflowSource, /ghcr\.io\/xmzo\/moemail-local-postgres"/)
assert.match(workflowSource, /ghcr\.io\/xmzo\/moemail-local-postgres-tools"/)
assert.equal((workflowSource.match(/dockerfile:/g) ?? []).length, 6)

const dockerfileSource = readFileSync("Dockerfile", "utf8")
assert.match(dockerfileSource, /npm install --global pnpm@11\.21\.0/)
for (const readmePath of ["README.md", "README.zh-CN.md"]) {
  const readme = readFileSync(readmePath, "utf8")
  assert.ok(readme.includes("/master/compose.yml"))
  assert.ok(readme.includes("/master/compose.postgres.yml"))
  assert.ok(readme.includes("moemail-local:latest"))
  assert.ok(readme.includes("moemail-local-postgres:latest"))
  assert.ok(readme.includes("moemail-local-postgres-tools:latest"))
  assert.doesNotMatch(
    readme,
    /raw\.githubusercontent\.com\/[^\s]+\/compose(?:\.postgres)?\.yaml/,
    "README must not download a legacy Compose filename",
  )
}

console.log(JSON.stringify({
  dualComposeFilesPresent: true,
  legacyComposeYamlRemoved: true,
  sqliteComposeUsesOnlyAppImage: true,
  sqliteComposeHasNoBundledPostgres: true,
  sqliteComposeBindsAllStateUnderData: true,
  sqliteComposeRestoreProfilePresent: true,
  postgresComposeUsesDedicatedPgImages: true,
  postgresComposeInternalNetworkOnly: true,
  externalPostgresToolsReachable: true,
  postgresServerMajor: serverMajor,
  postgresToolsMajor: toolsMajor,
  postgresRetentionRequiresConfigPair: true,
  postgresVerificationAndDumpShareSnapshot: true,
  strictPostgresTlsUsesSystemCa: true,
  postgresTargetInspectionIsRedacted: true,
  emailConfigSnapshotValidated: true,
  postgresRestoreRollsBackDatabaseAndConfig: true,
  systemdSuccessfulRestart: true,
  singleAuthoritativeWebStartupValidation: true,
  publishWorkflowTagsOrManualOnly: true,
  publishWorkflowRunsPreflight: true,
  publishWorkflowBuildsThreeImagesOnTwoNativeArchitectures: true,
  publishWorkflowAvoidsQemu: true,
  digestArtifactsAreImageKindDelimited: true,
  composeTracksLatestImages: true,
}, null, 2))
