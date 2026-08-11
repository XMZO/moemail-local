import {
  awaitInitialConfigReady,
  getConfigStatus,
} from "../../app/lib/config/runtime"

await awaitInitialConfigReady()
const status = getConfigStatus()
if (status.fatal) {
  console.error(JSON.stringify({
    event: "database.startup.skipped",
    reason: "config-recovery-required",
    configPath: status.path,
    issues: status.fatal,
  }))
} else if (!status.setupCompleted) {
  console.log(JSON.stringify({
    event: "database.startup.skipped",
    reason: "setup-required",
    configPath: status.path,
  }))
} else {
  await import("./migrate")
  await import("./verify")
  console.log(JSON.stringify({
    event: "database.startup.ok",
    configPath: status.path,
  }))
}
