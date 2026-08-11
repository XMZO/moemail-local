import Database from "better-sqlite3"
import { createHash, type Hash } from "node:crypto"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import type { PoolClient, QueryResult } from "pg"
import {
  closeDatabase,
  getDatabaseDriver,
  getPostgresPool,
} from "../../app/lib/db"
import { normalizeMailboxAddress } from "../../app/lib/email-address"
import { verifyPostgres } from "./lib"
import { requireValidatedRuntimeConfig } from "../ops/validated-runtime"

type ColumnKind = "boolean" | "date" | "value"
type ColumnSpec = {
  name: string
  kind?: ColumnKind
}
type TableSpec = {
  name: string
  columns: readonly ColumnSpec[]
  primaryKey: readonly string[]
  optional?: boolean
}
type TimestampStats = {
  milliseconds: number
  nulls: number
  seconds: number
  strings: number
}
type ImportDetails = Record<string, unknown>

class ImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: ImportDetails,
  ) {
    super(message)
    this.name = "ImportError"
  }
}

const column = (name: string, kind: ColumnKind = "value"): ColumnSpec => ({ name, kind })

const TABLES: readonly TableSpec[] = [
  {
    name: "user",
    columns: [
      column("id"), column("name"), column("email"), column("emailVerified", "date"),
      column("image"), column("username"), column("password"),
    ],
    primaryKey: ["id"],
  },
  {
    name: "role",
    columns: [
      column("id"), column("name"), column("description"),
      column("created_at", "date"), column("updated_at", "date"),
    ],
    primaryKey: ["id"],
  },
  {
    name: "account",
    columns: [
      column("userId"), column("type"), column("provider"),
      column("providerAccountId"), column("refresh_token"), column("access_token"),
      column("expires_at"), column("token_type"), column("scope"), column("id_token"),
      column("session_state"),
    ],
    primaryKey: ["provider", "providerAccountId"],
  },
  {
    name: "api_keys",
    columns: [
      column("id"), column("user_id"), column("name"), column("key"),
      column("created_at", "date"), column("expires_at", "date"),
      column("enabled", "boolean"),
    ],
    primaryKey: ["id"],
  },
  {
    name: "email",
    columns: [
      column("id"), column("address"), column("userId"),
      column("created_at", "date"), column("expires_at", "date"),
    ],
    primaryKey: ["id"],
  },
  {
    name: "user_role",
    columns: [
      column("user_id"), column("role_id"), column("created_at", "date"),
    ],
    primaryKey: ["user_id", "role_id"],
  },
  {
    name: "webhook",
    columns: [
      column("id"), column("user_id"), column("url"), column("enabled", "boolean"),
      column("created_at", "date"), column("updated_at", "date"),
    ],
    primaryKey: ["id"],
  },
  {
    name: "message",
    columns: [
      column("id"), column("emailId"), column("from_address"), column("to_address"),
      column("subject"), column("content"), column("html"), column("type"),
      column("received_at", "date"), column("sent_at", "date"),
    ],
    primaryKey: ["id"],
  },
  {
    name: "email_share",
    columns: [
      column("id"), column("email_id"), column("token"),
      column("created_at", "date"), column("expires_at", "date"),
    ],
    primaryKey: ["id"],
    optional: true,
  },
  {
    name: "message_share",
    columns: [
      column("id"), column("message_id"), column("token"),
      column("created_at", "date"), column("expires_at", "date"),
    ],
    primaryKey: ["id"],
    optional: true,
  },
]

const DELETE_ORDER = [...TABLES].reverse()
const batchSize = 500

function quoteIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`
}

function parseArguments(args: string[]) {
  let sourceArgument: string | undefined
  let force = false

  for (const argument of args) {
    if (argument === "--force") {
      force = true
      continue
    }
    if (argument.startsWith("--")) {
      throw new ImportError("INVALID_ARGUMENT", `Unknown option: ${argument}`)
    }
    if (sourceArgument) {
      throw new ImportError("INVALID_ARGUMENT", "Only one source SQLite file may be provided")
    }
    sourceArgument = argument
  }

  if (!sourceArgument) {
    throw new ImportError(
      "INVALID_ARGUMENT",
      "Usage: pnpm db:postgres:import-d1 <source.db> [--force]",
    )
  }

  return { force, sourceArgument }
}

function listSourceTables(sqlite: Database.Database) {
  const rows = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>
  return new Set(rows.map(row => row.name))
}

function listSourceColumns(sqlite: Database.Database, table: string) {
  const rows = sqlite
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all() as Array<{ name: string }>
  return new Set(rows.map(row => row.name))
}

function sourceExpression(table: string, columnName: string, sourceColumns: Set<string>) {
  if (sourceColumns.has(columnName)) return quoteIdentifier(columnName)
  if (table === "message" && columnName === "to_address") return "NULL"
  if (table === "message" && columnName === "type") return "'received'"
  if (table === "message" && columnName === "sent_at") return quoteIdentifier("received_at")
  throw new ImportError(
    "SOURCE_SCHEMA_MISMATCH",
    `No compatibility mapping exists for ${table}.${columnName}`,
  )
}

function inspectSource(sqlite: Database.Database) {
  const sourceTables = listSourceTables(sqlite)
  const missingTables = TABLES
    .filter(table => !table.optional && !sourceTables.has(table.name))
    .map(table => table.name)
  if (missingTables.length > 0) {
    throw new ImportError(
      "SOURCE_SCHEMA_MISMATCH",
      "Source database is missing required MoeMail tables",
      { missingTables },
    )
  }

  const columnsByTable = new Map<string, Set<string>>()
  for (const table of TABLES) {
    if (!sourceTables.has(table.name)) continue
    const sourceColumns = listSourceColumns(sqlite, table.name)
    const compatibleMissing = table.name === "message"
      ? new Set(["to_address", "type", "sent_at"])
      : new Set<string>()
    const missingColumns = table.columns
      .map(item => item.name)
      .filter(name => !sourceColumns.has(name) && !compatibleMissing.has(name))
    if (missingColumns.length > 0) {
      throw new ImportError(
        "SOURCE_SCHEMA_MISMATCH",
        `Source table ${table.name} is missing required columns`,
        { missingColumns, table: table.name },
      )
    }
    columnsByTable.set(table.name, sourceColumns)
  }

  return { columnsByTable, sourceTables }
}

function validateSourceEmailAddresses(sqlite: Database.Database) {
  const rows = sqlite.prepare(`
    SELECT id, address
    FROM email
    ORDER BY id
  `).all() as Array<{ id: string; address: unknown }>
  const invalid: Array<{ id: string; address: unknown }> = []
  const counts = new Map<string, number>()

  for (const row of rows) {
    const normalizedAddress = normalizeMailboxAddress(row.address)
    if (!normalizedAddress) {
      if (invalid.length < 20) invalid.push(row)
      continue
    }
    counts.set(normalizedAddress, (counts.get(normalizedAddress) ?? 0) + 1)
  }

  if (invalid.length > 0) {
    throw new ImportError(
      "INVALID_EMAIL_ADDRESS",
      "Source contains an email address outside the supported ASCII mailbox format",
      { invalid },
    )
  }

  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .slice(0, 20)
    .map(([normalizedAddress, count]) => ({ normalizedAddress, count }))

  if (duplicates.length > 0) {
    throw new ImportError(
      "DUPLICATE_EMAIL_ADDRESS",
      "Source contains email addresses that differ only by case",
      { duplicates },
    )
  }
}

function validateSourceEmperor(sqlite: Database.Database) {
  const row = sqlite.prepare(`
    SELECT COUNT(DISTINCT user_role.user_id) AS count
    FROM user_role
    INNER JOIN role ON role.id = user_role.role_id
    WHERE role.name = ?
  `).get("emperor") as { count: number }

  if (Number(row.count) > 1) {
    throw new ImportError(
      "MULTIPLE_EMPEROR_USERS",
      "Source contains multiple emperor users",
      { count: Number(row.count) },
    )
  }
}

function timestampStatsKey(table: string, columnName: string) {
  return `${table}.${columnName}`
}

function normalizeDate(
  value: unknown,
  label: string,
  timestampStats: Record<string, TimestampStats>,
) {
  const stats = timestampStats[label] ?? {
    milliseconds: 0,
    nulls: 0,
    seconds: 0,
    strings: 0,
  }
  timestampStats[label] = stats

  if (value === null || value === undefined) {
    stats.nulls += 1
    return null
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new ImportError("INVALID_TIMESTAMP", `Invalid timestamp in ${label}`)
    }
    stats.strings += 1
    return value
  }

  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())
      ? Number(value)
      : null
  if (numeric !== null) {
    if (!Number.isFinite(numeric)) {
      throw new ImportError("INVALID_TIMESTAMP", `Invalid numeric timestamp in ${label}`)
    }
    const milliseconds = Math.abs(numeric) < 100_000_000_000
      ? (stats.seconds += 1, numeric * 1_000)
      : (stats.milliseconds += 1, numeric)
    const date = new Date(milliseconds)
    if (Number.isNaN(date.getTime())) {
      throw new ImportError("INVALID_TIMESTAMP", `Out-of-range timestamp in ${label}`)
    }
    return date
  }

  if (typeof value === "string") {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) {
      stats.strings += 1
      return date
    }
  }

  throw new ImportError("INVALID_TIMESTAMP", `Unsupported timestamp in ${label}`)
}

function normalizeValue(
  value: unknown,
  table: TableSpec,
  columnSpec: ColumnSpec,
  timestampStats: Record<string, TimestampStats>,
) {
  if (columnSpec.kind === "date") {
    return normalizeDate(
      value,
      timestampStatsKey(table.name, columnSpec.name),
      timestampStats,
    )
  }
  if (columnSpec.kind === "boolean") {
    if (value === null || value === undefined) return null
    if (value === true || value === 1 || value === "1" || value === "true") return true
    if (value === false || value === 0 || value === "0" || value === "false") return false
    throw new ImportError(
      "INVALID_BOOLEAN",
      `Unsupported boolean in ${table.name}.${columnSpec.name}`,
    )
  }
  if (typeof value === "string" && value.includes("\0")) {
    throw new ImportError(
      "POSTGRES_TEXT_NUL",
      `PostgreSQL text cannot store NUL bytes in ${table.name}.${columnSpec.name}`,
      { column: columnSpec.name, table: table.name },
    )
  }
  return value === undefined ? null : value
}

function canonicalValue(value: unknown) {
  if (value === null || value === undefined) return "null"
  if (value instanceof Date) return `date:${value.toISOString()}`
  if (typeof value === "boolean") return value ? "boolean:true" : "boolean:false"
  if (typeof value === "number") return `number:${value}`
  return `string:${String(value)}`
}

function updateHash(hash: Hash, values: readonly unknown[]) {
  for (const value of values) {
    const normalized = canonicalValue(value)
    hash.update(`${Buffer.byteLength(normalized)}:`)
    hash.update(normalized)
  }
  hash.update("\n")
}

function createFingerprints() {
  return {
    row: createHash("sha256"),
    messageBody: createHash("sha256"),
  }
}

function updateFingerprints(
  fingerprints: ReturnType<typeof createFingerprints>,
  table: TableSpec,
  row: Record<string, unknown>,
) {
  updateHash(fingerprints.row, table.columns.map(item => row[item.name]))
  if (table.name === "message") {
    updateHash(fingerprints.messageBody, [row.id, row.subject, row.content, row.html])
  }
}

async function insertBatch(
  client: PoolClient,
  table: TableSpec,
  rows: readonly Record<string, unknown>[],
) {
  if (rows.length === 0) return
  const columns = table.columns.map(item => item.name)
  const values: unknown[] = []
  const valueGroups = rows.map((row, rowIndex) => {
    const placeholders = columns.map((name, columnIndex) => {
      values.push(row[name])
      return `$${rowIndex * columns.length + columnIndex + 1}`
    })
    return `(${placeholders.join(", ")})`
  })
  await client.query(`
    INSERT INTO ${quoteIdentifier(table.name)} (${columns.map(quoteIdentifier).join(", ")})
    VALUES ${valueGroups.join(", ")}
  `, values)
}

async function importTable(
  client: PoolClient,
  source: Database.Database,
  table: TableSpec,
  sourceColumns: Set<string>,
  timestampStats: Record<string, TimestampStats>,
) {
  const selectedColumns = table.columns.map(item => (
    `${sourceExpression(table.name, item.name, sourceColumns)} AS ${quoteIdentifier(item.name)}`
  ))
  const orderBy = table.primaryKey.map(quoteIdentifier).join(", ")
  const statement = source.prepare(`
    SELECT ${selectedColumns.join(", ")}
    FROM ${quoteIdentifier(table.name)}
    ORDER BY ${orderBy}
  `)
  const fingerprints = createFingerprints()
  const pending: Record<string, unknown>[] = []
  let rows = 0

  for (const sourceRow of statement.iterate() as Iterable<Record<string, unknown>>) {
    const normalized = Object.fromEntries(table.columns.map(item => [
      item.name,
      normalizeValue(sourceRow[item.name], table, item, timestampStats),
    ]))
    updateFingerprints(fingerprints, table, normalized)
    pending.push(normalized)
    rows += 1
    if (pending.length >= batchSize) {
      await insertBatch(client, table, pending)
      pending.length = 0
    }
  }
  await insertBatch(client, table, pending)

  return {
    rows,
    rowHash: fingerprints.row.digest("hex"),
    messageBodyHash: table.name === "message"
      ? fingerprints.messageBody.digest("hex")
      : null,
  }
}

async function fingerprintTarget(client: PoolClient, table: TableSpec) {
  const selectedColumns = table.columns.map(item => quoteIdentifier(item.name)).join(", ")
  const keyColumns = table.primaryKey.map(quoteIdentifier)
  const fingerprints = createFingerprints()
  let lastKey: unknown[] | null = null
  let rows = 0

  while (true) {
    const where: string = lastKey
      ? `WHERE (${keyColumns.join(", ")}) > (${lastKey.map((_, index) => `$${index + 1}`).join(", ")})`
      : ""
    const parameters: unknown[] = lastKey ? [...lastKey, batchSize] : [batchSize]
    const limitParameter: string = `$${parameters.length}`
    const result: QueryResult<Record<string, unknown>> = await client.query(`
      SELECT ${selectedColumns}
      FROM ${quoteIdentifier(table.name)}
      ${where}
      ORDER BY ${keyColumns.join(", ")}
      LIMIT ${limitParameter}
    `, parameters)
    if (result.rows.length === 0) break

    for (const row of result.rows) {
      updateFingerprints(fingerprints, table, row)
      rows += 1
    }
    const lastRow: Record<string, unknown> = result.rows[result.rows.length - 1]
    lastKey = table.primaryKey.map((name): unknown => lastRow[name])
  }

  return {
    rows,
    rowHash: fingerprints.row.digest("hex"),
    messageBodyHash: table.name === "message"
      ? fingerprints.messageBody.digest("hex")
      : null,
  }
}

async function tableCount(client: PoolClient, table: string) {
  const result = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${quoteIdentifier(table)}`,
  )
  return Number(result.rows[0].count)
}

async function main() {
  if (getDatabaseDriver() !== "postgres") {
    throw new ImportError(
      "WRONG_DATABASE_DRIVER",
      "Set database.driver to postgres in data/config.yaml before importing into PostgreSQL",
    )
  }

  const startedAt = Date.now()
  const { force, sourceArgument } = parseArguments(process.argv.slice(2))
  const sourcePath = realpathSync(resolve(process.cwd(), sourceArgument))
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true })
  const pool = getPostgresPool()
  const client = await pool.connect()

  try {
    const { columnsByTable, sourceTables } = inspectSource(source)
    validateSourceEmailAddresses(source)
    validateSourceEmperor(source)
    await verifyPostgres(client)
    await client.query("BEGIN")
    try {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('moemail:import-d1'))")
      const targetBefore = Object.fromEntries(
        await Promise.all(TABLES.map(async table => [
          table.name,
          await tableCount(client, table.name),
        ])),
      ) as Record<string, number>
      const nonEmptyTables = Object.fromEntries(
        Object.entries(targetBefore).filter(([, count]) => count > 0),
      )
      if (!force && Object.keys(nonEmptyTables).length > 0) {
        throw new ImportError(
          "TARGET_NOT_EMPTY",
          "Target contains business data; rerun with --force to replace it",
          { nonEmptyTables },
        )
      }

      let clearedRows = 0
      if (force) {
        for (const table of DELETE_ORDER) {
          const result = await client.query(
            `DELETE FROM ${quoteIdentifier(table.name)}`,
          )
          clearedRows += result.rowCount ?? 0
        }
      }

      const timestampStats: Record<string, TimestampStats> = {}
      const results: Array<Record<string, unknown>> = []
      for (const table of TABLES) {
        if (!sourceTables.has(table.name)) {
          results.push({
            table: table.name,
            sourcePresent: false,
            sourceRows: 0,
            targetRows: 0,
            rowHash: null,
            messageBodyHash: null,
          })
          continue
        }
        const sourceColumns = columnsByTable.get(table.name)
        if (!sourceColumns) {
          throw new ImportError(
            "SOURCE_SCHEMA_MISMATCH",
            `Source metadata is unavailable for table ${table.name}`,
          )
        }

        const sourceResult = await importTable(
          client,
          source,
          table,
          sourceColumns,
          timestampStats,
        )
        const targetResult = await fingerprintTarget(client, table)
        if (
          sourceResult.rows !== targetResult.rows
          || sourceResult.rowHash !== targetResult.rowHash
          || sourceResult.messageBodyHash !== targetResult.messageBodyHash
        ) {
          throw new ImportError(
            "CONTENT_MISMATCH",
            `Content verification failed for table ${table.name}`,
            { source: sourceResult, table: table.name, target: targetResult },
          )
        }
        results.push({
          table: table.name,
          sourcePresent: true,
          sourceRows: sourceResult.rows,
          targetRows: targetResult.rows,
          rowHash: sourceResult.rowHash,
          messageBodyHash: sourceResult.messageBodyHash,
        })
      }

      await client.query("COMMIT")
      const messageColumns = columnsByTable.get("message")!
      const verification = await verifyPostgres(client)
      return {
        event: "postgres.d1_import.ok",
        source: sourcePath,
        target: verification.database,
        force,
        clearedRows,
        durationMs: Date.now() - startedAt,
        messageCompatibility: {
          defaultedToAddress: !messageColumns.has("to_address"),
          defaultedType: !messageColumns.has("type"),
          defaultedSentAt: !messageColumns.has("sent_at"),
        },
        timestampStats,
        tables: results,
      }
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    }
  } finally {
    client.release()
    source.close()
    await closeDatabase()
  }
}

await requireValidatedRuntimeConfig("PostgreSQL D1 import")

try {
  console.log(JSON.stringify(await main()))
} catch (error) {
  const importError = error instanceof ImportError ? error : null
  const systemCode = error && typeof error === "object" && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null
  console.error(JSON.stringify({
    event: "postgres.d1_import.error",
    code: importError?.code || systemCode || "UNEXPECTED_ERROR",
    message: error instanceof Error ? error.message : String(error),
    details: importError?.details,
  }))
  process.exitCode = 1
}
