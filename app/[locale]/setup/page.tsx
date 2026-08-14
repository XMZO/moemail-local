import { redirect } from "next/navigation"
import { SetupWizard } from "@/components/setup/setup-wizard"
import {
  getConfig,
  getConfigStatus,
  getSetupRecoveryConfig,
  isSetupCompleted,
} from "@/lib/config/runtime"
import { readLastKnownGoodFile } from "@/lib/config/file"
import { ensureSetupToken, getSetupTokenPath } from "@/lib/setup-token"
import { stringify } from "yaml"
import { SetupHeader } from "@/components/layout/setup-header"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export default async function SetupPage() {
  if (isSetupCompleted()) {
    redirect("/")
  }

  const status = getConfigStatus()
  let config
  try {
    config = getConfig()
  } catch {
    config = getSetupRecoveryConfig()
  }

  // 令牌只写入权限受限的本地文件并输出到服务日志，不发送到浏览器。
  // 页面只展示文件位置，由部署者手动复制令牌完成所有权证明。
  ensureSetupToken()

  // loadedFromFile 也必须算已持久化：主文件/LKG 被删除后，runtime 会为可用性
  // 暂时保留内存中的 staged 配置，其中可能已有数据库密码或 rclone 凭据。
  let hasPersistedConfig = status.loadedFromFile
    || status.bootCandidatePending
    || status.fileExists
  if (!hasPersistedConfig) {
    try {
      hasPersistedConfig = Boolean(readLastKnownGoodFile(status.path))
    } catch {
      // 无法确认 LKG 是否安全时按“已持久化”处理，绝不向匿名页面回显高级值。
      hasPersistedConfig = true
    }
  }

  const freshAdvancedYaml = stringify({
    server: {
      autoRestartOnDriverChange: config.server.autoRestartOnDriverChange,
    },
    database: {
      sqlite: {
        backupDir: config.database.sqlite.backupDir,
        backupRetentionDays: config.database.sqlite.backupRetentionDays,
      },
      postgres: {
        poolMax: config.database.postgres.poolMax,
        idleTimeoutMs: config.database.postgres.idleTimeoutMs,
        connectTimeoutMs: config.database.postgres.connectTimeoutMs,
        applicationName: config.database.postgres.applicationName,
        backupDir: config.database.postgres.backupDir,
        backupRetentionDays: config.database.postgres.backupRetentionDays,
      },
    },
    auth: {
      emperorBootstrapSecret: config.auth.emperorBootstrapSecret,
      rateLimit: config.auth.rateLimit,
    },
    cleanup: config.cleanup,
    scheduler: config.scheduler,
    monitor: {
      intervalSeconds: config.monitor.intervalSeconds,
      healthcheckUrl: config.monitor.healthcheckUrl,
      diskPath: config.monitor.diskPath,
      accessLog: config.monitor.accessLog,
      minFreePercent: config.monitor.minFreePercent,
      minFreeGb: config.monitor.minFreeGb,
      maxWalMb: config.monitor.maxWalMb,
      maxPostgresDatabaseGb: config.monitor.maxPostgresDatabaseGb,
      windowMinutes: config.monitor.windowMinutes,
      maxHttp5xx: config.monitor.maxHttp5xx,
      maxIngestFailures: config.monitor.maxIngestFailures,
      alertWebhookUrl: config.monitor.alertWebhookUrl,
      alertBearerToken: config.monitor.alertBearerToken,
    },
    offsite: {
      remote: config.offsite.remote,
      intervalSeconds: config.offsite.intervalSeconds,
      rcloneBin: config.offsite.rcloneBin,
      rcloneConfigContent: config.offsite.rcloneConfigContent,
    },
  }, { lineWidth: 0 })
  const advancedYaml = hasPersistedConfig ? "" : freshAdvancedYaml

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800">
      <SetupHeader />
      <SetupWizard
        configPath={status.path}
        setupTokenPath={getSetupTokenPath()}
        configInvalid={Boolean(status.fatal)}
        advancedYaml={advancedYaml}
        advancedValuesPreserved={hasPersistedConfig}
        defaults={{
          server: {
            baseUrl: config.server.baseUrl,
            trustProxyHeaders: config.server.trustProxyHeaders,
            emailPollIntervalMs: config.server.emailPollIntervalMs,
          },
          database: {
            driver: config.database.driver,
            sqlite: { path: config.database.sqlite.path },
            postgres: {
              // setup=false 页面是匿名可达的，绝不把可能含密码的已暂存 URL 回显。
              url: hasPersistedConfig
                ? null
                : "postgresql://moemail@postgres:5432/moemail",
              ssl: config.database.postgres.ssl,
              sslRejectUnauthorized: config.database.postgres.sslRejectUnauthorized,
            },
          },
        }}
      />
    </div>
  )
}
