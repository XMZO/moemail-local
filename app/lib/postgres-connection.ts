export interface PostgresConnectionTarget {
  host: string
  port: string
  database: string
  user: string
  password: string
}

/** 本地应用的 PostgreSQL 行为只来自 YAML。删除而不是读取继承的 PG*，
 * 同时封住 node-postgres 的 PGBINARY 等非标准 fallback。 */
export function discardInheritedPostgresEnvironment() {
  for (const key of Object.keys(process.env)) {
    if (/^PG/i.test(key)) delete process.env[key]
  }
}

/**
 * PostgreSQL URI 的唯一解析规则。所有调用方都 materialize 同一目标，避免
 * node-postgres、libpq 与 URL query/environment 各自覆盖字段。
 */
export function parsePostgresConnectionUrl(url: string): PostgresConnectionTarget {
  if (/[\u0000-\u0020\u007f]/.test(url)) {
    throw new Error("POSTGRES_URL_WHITESPACE_FORBIDDEN")
  }
  const databaseUrl = new URL(url)
  if (databaseUrl.protocol !== "postgres:" && databaseUrl.protocol !== "postgresql:") {
    throw new Error("POSTGRES_URL_PROTOCOL_INVALID")
  }
  if (databaseUrl.searchParams.size > 0) {
    throw new Error("POSTGRES_URL_QUERY_FORBIDDEN")
  }
  if (databaseUrl.hash) {
    throw new Error("POSTGRES_URL_FRAGMENT_FORBIDDEN")
  }

  const encodedDatabase = databaseUrl.pathname.slice(1)
  // 数据库名中的斜线必须写成 %2F；裸斜线会让 URI parser 产生歧义。
  if (encodedDatabase.includes("/")) {
    throw new Error("POSTGRES_DATABASE_SLASH_UNENCODED")
  }

  const target = {
    host: databaseUrl.hostname.replace(/^\[|\]$/g, ""),
    port: databaseUrl.port || "5432",
    database: decodeURIComponent(encodedDatabase),
    user: decodeURIComponent(databaseUrl.username),
    password: decodeURIComponent(databaseUrl.password),
  }
  if (target.host.includes("%")) {
    throw new Error("POSTGRES_HOST_PERCENT_ENCODING_FORBIDDEN")
  }
  if (!target.host || !target.database || !target.user) {
    throw new Error("POSTGRES_TARGET_INCOMPLETE")
  }
  if (Object.values(target).some(value => value.includes("\0"))) {
    throw new Error("POSTGRES_CONNECTION_NUL_FORBIDDEN")
  }
  return target
}
