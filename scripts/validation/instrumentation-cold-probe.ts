import { registerNodeRuntime } from "../../instrumentation-node"

const mode = process.argv.includes("--maintenance") ? "maintenance" : "instrumentation"
const startedAt = Date.now()
if (mode === "maintenance") {
  const { requireValidatedRuntimeConfig } = await import("../ops/validated-runtime")
  await requireValidatedRuntimeConfig("cold-start maintenance probe")
} else {
  await registerNodeRuntime()
}
const elapsedMs = Date.now() - startedAt

const { getConfig, getConfigStatus } = await import("../../app/lib/config/runtime")
const { getBoundDriver } = await import("../../app/lib/database-dialect")
const { closeDatabase, getPostgresPool, getSqlite } = await import("../../app/lib/db")

const status = getConfigStatus()
const activeDriver = getConfig().database.driver
const boundDriver = getBoundDriver()
if (boundDriver === "sqlite") getSqlite().prepare("SELECT 1").get()
else await getPostgresPool().query("SELECT 1")
await closeDatabase()

console.log(`__MOEMAIL_INSTRUMENTATION_PROBE__${JSON.stringify({
  mode,
  elapsedMs,
  status,
  activeDriver,
  boundDriver,
  databaseOpened: true,
})}`)
