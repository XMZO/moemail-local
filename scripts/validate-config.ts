import {
  awaitInitialConfigReady,
  getConfig,
  getConfigStatus,
} from "../app/lib/config/runtime"
import { authRateLimitOptionsFrom } from "../app/lib/auth-abuse-guard"

await awaitInitialConfigReady()
const status = getConfigStatus()
if (status.fatal) {
  const { ensureSetupToken, getSetupTokenPath } = await import("../app/lib/setup-token")
  ensureSetupToken()
  console.error(JSON.stringify({
    event: "runtime-config.recovery-required",
    configPath: status.path,
    setupTokenPath: getSetupTokenPath(),
    issues: status.fatal,
  }))
  process.exit(0)
}
if (!status.setupCompleted) {
  const { ensureSetupToken, getSetupTokenPath } = await import("../app/lib/setup-token")
  ensureSetupToken()
  console.log(JSON.stringify({
    event: "runtime-config.setup-required",
    configPath: status.path,
    setupTokenPath: getSetupTokenPath(),
  }))
  process.exit(0)
}

// 若进程在最终配置落盘后、删除令牌前退出，下一次启动负责收尾。
const { removeSetupToken } = await import("../app/lib/setup-token")
removeSetupToken()

const config = getConfig()
console.log(JSON.stringify({
  event: "runtime-config.verify.ok",
  configPath: status.path,
  databaseDriver: config.database.driver,
  authRateLimit: authRateLimitOptionsFrom(config),
  authScryptMaxConcurrency: config.auth.rateLimit.scryptMaxConcurrency,
}))
