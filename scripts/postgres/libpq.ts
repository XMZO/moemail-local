import type { AppConfig } from "../../app/lib/config/schema"
import {
  parsePostgresConnectionUrl,
  type PostgresConnectionTarget,
} from "../../app/lib/postgres-connection"

export type LibpqSslMode = "disable" | "require" | "verify-full"

export interface LibpqSslResolution {
  mode: LibpqSslMode
  source: "yaml"
}

export type PostgresTarget = Omit<PostgresConnectionTarget, "password">

export function resolvePostgresTarget(
  postgres: AppConfig["database"]["postgres"],
): PostgresTarget {
  if (!postgres.url) throw new Error("database.postgres.url is required")
  const parsed = parsePostgresConnectionUrl(postgres.url)
  return {
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    user: parsed.user,
  }
}

function quoteLibpqConninfo(value: string) {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
}

/** Password stays in PGPASSWORD, never argv. Every target field is quoted as a
 * literal conninfo value so a database name containing `=`, spaces or URI text
 * cannot inject host/user/port overrides into pg_restore. */
export function postgresTargetConninfo(
  postgres: AppConfig["database"]["postgres"],
) {
  const target = resolvePostgresTarget(postgres)
  return [
    `host=${quoteLibpqConninfo(target.host)}`,
    `port=${quoteLibpqConninfo(target.port)}`,
    `user=${quoteLibpqConninfo(target.user)}`,
    `dbname=${quoteLibpqConninfo(target.database)}`,
  ].join(" ")
}

/**
 * TLS 只允许由 YAML 控制，并映射为 disable / require / verify-full。
 * URL query 参数在 node-postgres 与 libpq 中存在不同覆盖语义，因此全部拒绝。
 */
export function resolveLibpqSslMode(
  postgres: AppConfig["database"]["postgres"],
): LibpqSslResolution {
  if (!postgres.url) throw new Error("database.postgres.url is required")
  parsePostgresConnectionUrl(postgres.url)

  if (!postgres.ssl) return { mode: "disable", source: "yaml" }
  return {
    mode: postgres.sslRejectUnauthorized ? "verify-full" : "require",
    source: "yaml",
  }
}
