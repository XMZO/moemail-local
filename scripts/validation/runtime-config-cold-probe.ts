import {
  getConfig,
  getConfigStatus,
  getSetupRecoveryConfig,
  reloadConfig,
} from "../../app/lib/config/runtime"

const before = getConfigStatus()
let unverifiedGetConfigRejected = false
try {
  getConfig()
} catch {
  unverifiedGetConfigRejected = before.bootCandidatePending
}
const reload = await reloadConfig()
const after = getConfigStatus()
const recoveryConfig = getSetupRecoveryConfig()
let activeDriver: "sqlite" | "postgres" | null = null
let boundDriver: "sqlite" | "postgres" | null = null
let databaseOpened = false
if (after.setupCompleted) {
  activeDriver = getConfig().database.driver
  const { getBoundDriver } = await import("../../app/lib/database-dialect")
  const { closeDatabase, getPostgresPool, getSqlite } = await import("../../app/lib/db")
  boundDriver = getBoundDriver()
  if (boundDriver === "sqlite") getSqlite().prepare("SELECT 1").get()
  else await getPostgresPool().query("SELECT 1")
  databaseOpened = true
  await closeDatabase()
}

console.log(`__MOEMAIL_COLD_PROBE__${JSON.stringify({
  before,
  unverifiedGetConfigRejected,
  reload,
  after,
  activeDriver,
  boundDriver,
  databaseOpened,
  recoveryCandidate: {
    setupCompleted: recoveryConfig.setup.completed,
    passwordPepperPresent: Boolean(recoveryConfig.auth.passwordPepper),
  },
})}`)
