import { getConfig } from "./config/runtime"

export type DatabaseDriver = "sqlite" | "postgres"

type DriverGlobals = typeof globalThis & {
  __moemailBoundDriver?: DatabaseDriver
}

const driverGlobals = globalThis as DriverGlobals

/** 配置文件中当前声明的数据库类型。 */
export function getConfiguredDriver(): DatabaseDriver {
  return getConfig().database.driver
}

/**
 * 本进程实际绑定的数据库类型。schema facade 与迁移目录在模块加载时按它选择，
 * 因此运行中切换 driver 必须重启进程；其余数据库参数支持热重连。
 */
export function getBoundDriver(): DatabaseDriver {
  driverGlobals.__moemailBoundDriver ??= getConfiguredDriver()
  return driverGlobals.__moemailBoundDriver
}

export function requirePostgresUrl() {
  const databaseUrl = getConfig().database.postgres.url
  if (!databaseUrl) {
    throw new Error("数据库类型为 postgres 时必须配置 database.postgres.url")
  }
  return databaseUrl
}
