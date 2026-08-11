import type { AppConfig } from "../../app/lib/config/schema"
import {
  awaitInitialConfigReady,
  getConfig,
  getConfigStatus,
  reloadConfig,
} from "../../app/lib/config/runtime"

/**
 * Destructive/operational CLI commands must not consume the schema-valid primary
 * candidate exposed during cold boot. Wait for database migration plus the
 * single-owner invariant, then use only the active validated runtime config.
 */
export async function requireValidatedRuntimeConfig(operation: string): Promise<AppConfig> {
  let status = getConfigStatus()
  const initialCandidatePending = status.bootCandidatePending
  if (initialCandidatePending) {
    await awaitInitialConfigReady()
    status = getConfigStatus()
  } else if (!status.loadedFromFile) {
    // 没有 boot candidate 时保留一次显式磁盘读取，以覆盖进程启动与命令
    // 执行之间刚写入首份配置的窄竞态。
    await reloadConfig()
    status = getConfigStatus()
  }
  if (status.fatal || !status.loadedFromFile || !status.setupCompleted) {
    throw new Error(
      `${operation} refused: no completed, database-validated runtime configuration is active`,
    )
  }
  return getConfig()
}
