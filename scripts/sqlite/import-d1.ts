import Database from "better-sqlite3"
import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { resolveDatabasePath } from "./lib"
import { normalizeMailboxAddress } from "../../app/lib/email-address"
import { requireValidatedRuntimeConfig } from "../ops/validated-runtime"

type TableSpec = {
  name: string
  columns: readonly string[]
  optional?: boolean
}

type TableResult = {
  table: string
  sourcePresent: boolean
  sourceRows: number
  insertedRows: number
  targetRows: number
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

const TABLES: readonly TableSpec[] = [
  {
    name: "user",
    columns: ["id", "name", "email", "emailVerified", "image", "username", "password"],
  },
  {
    name: "role",
    columns: ["id", "name", "description", "created_at", "updated_at"],
  },
  {
    name: "account",
    columns: [
      "userId",
      "type",
      "provider",
      "providerAccountId",
      "refresh_token",
      "access_token",
      "expires_at",
      "token_type",
      "scope",
      "id_token",
      "session_state",
    ],
  },
  {
    name: "api_keys",
    columns: ["id", "user_id", "name", "key", "created_at", "expires_at", "enabled"],
  },
  {
    name: "email",
    columns: ["id", "address", "userId", "created_at", "expires_at"],
  },
  {
    name: "user_role",
    columns: ["user_id", "role_id", "created_at"],
  },
  {
    name: "webhook",
    columns: ["id", "user_id", "url", "enabled", "created_at", "updated_at"],
  },
  {
    name: "message",
    columns: [
      "id",
      "emailId",
      "from_address",
      "to_address",
      "subject",
      "content",
      "html",
      "type",
      "received_at",
      "sent_at",
    ],
  },
  {
    name: "email_share",
    columns: ["id", "email_id", "token", "created_at", "expires_at"],
    optional: true,
  },
  {
    name: "message_share",
    columns: ["id", "message_id", "token", "created_at", "expires_at"],
    optional: true,
  },
] as const

const DELETE_ORDER = [...TABLES].reverse()
const SOURCE_SCHEMA = "source_d1"
const TIMESTAMP_COLUMNS = [
  { table: "user", column: "emailVerified", unit: "milliseconds" },
  { table: "email", column: "created_at", unit: "milliseconds" },
  { table: "email", column: "expires_at", unit: "milliseconds" },
  { table: "message", column: "received_at", unit: "milliseconds" },
  { table: "message", column: "sent_at", unit: "milliseconds" },
  { table: "webhook", column: "created_at", unit: "milliseconds" },
  { table: "webhook", column: "updated_at", unit: "milliseconds" },
  { table: "email_share", column: "created_at", unit: "milliseconds", optional: true },
  { table: "email_share", column: "expires_at", unit: "milliseconds", optional: true },
  { table: "message_share", column: "created_at", unit: "milliseconds", optional: true },
  { table: "message_share", column: "expires_at", unit: "milliseconds", optional: true },
  { table: "account", column: "expires_at", unit: "seconds" },
  { table: "role", column: "created_at", unit: "seconds" },
  { table: "role", column: "updated_at", unit: "seconds" },
  { table: "user_role", column: "created_at", unit: "seconds" },
  { table: "api_keys", column: "created_at", unit: "seconds" },
  { table: "api_keys", column: "expires_at", unit: "seconds" },
] as const

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
      "Usage: pnpm db:sqlite:import-d1 <source.db> [--force]",
    )
  }

  return { force, sourceArgument }
}

function listTables(sqlite: Database.Database, schema = "main") {
  return new Set(
    (sqlite
      .prepare(`SELECT name FROM ${quoteIdentifier(schema)}.sqlite_master WHERE type = 'table'`)
      .all() as Array<{ name: string }>)
      .map(({ name }) => name),
  )
}

function listColumns(sqlite: Database.Database, schema: string, table: string) {
  return new Set(
    (sqlite
      .prepare(`PRAGMA ${quoteIdentifier(schema)}.table_info(${quoteIdentifier(table)})`)
      .all() as Array<{ name: string }>)
      .map(({ name }) => name),
  )
}

function countRows(sqlite: Database.Database, schema: string, table: string) {
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS count FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`,
    )
    .get() as { count: number }
  return Number(row.count)
}

function validateTargetSchema(sqlite: Database.Database) {
  const tables = listTables(sqlite)
  const missingTables = TABLES
    .map(({ name }) => name)
    .filter((table) => !tables.has(table))

  if (missingTables.length > 0) {
    throw new ImportError(
      "TARGET_SCHEMA_MISMATCH",
      "Target database has not been initialized with the local baseline",
      { missingTables },
    )
  }

  for (const table of TABLES) {
    const columns = listColumns(sqlite, "main", table.name)
    const missingColumns = table.columns.filter((column) => !columns.has(column))
    if (missingColumns.length > 0) {
      throw new ImportError(
        "TARGET_SCHEMA_MISMATCH",
        `Target table ${table.name} is missing required columns`,
        { missingColumns, table: table.name },
      )
    }
  }
}

function inspectSourceSchema(sqlite: Database.Database) {
  const tables = listTables(sqlite)
  const missingTables = TABLES
    .filter(({ name, optional }) => !optional && !tables.has(name))
    .map(({ name }) => name)

  if (missingTables.length > 0) {
    throw new ImportError(
      "SOURCE_SCHEMA_MISMATCH",
      "Source database is missing required MoeMail tables",
      { missingTables },
    )
  }

  const columnsByTable = new Map<string, Set<string>>()
  for (const table of TABLES) {
    if (!tables.has(table.name)) {
      continue
    }

    const columns = listColumns(sqlite, "main", table.name)
    const compatibleMissingColumns = table.name === "message"
      ? new Set(["to_address", "type", "sent_at"])
      : new Set<string>()
    const missingColumns = table.columns.filter(
      (column) => !columns.has(column) && !compatibleMissingColumns.has(column),
    )

    if (missingColumns.length > 0) {
      throw new ImportError(
        "SOURCE_SCHEMA_MISMATCH",
        `Source table ${table.name} is missing required columns`,
        { missingColumns, table: table.name },
      )
    }
    columnsByTable.set(table.name, columns)
  }

  return { columnsByTable, tables }
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

function sourceExpression(table: string, column: string, sourceColumns: Set<string>) {
  if (sourceColumns.has(column)) {
    return quoteIdentifier(column)
  }
  if (table === "message" && column === "to_address") {
    return "NULL"
  }
  if (table === "message" && column === "type") {
    return "'received'"
  }
  if (table === "message" && column === "sent_at") {
    return quoteIdentifier("received_at")
  }

  throw new ImportError(
    "SOURCE_SCHEMA_MISMATCH",
    `No compatibility mapping exists for ${table}.${column}`,
  )
}

function validateTimestampRanges(sqlite: Database.Database) {
  const invalid: Array<{ table: string; column: string; unit: string; rows: number }> = []

  for (const spec of TIMESTAMP_COLUMNS) {
    const tables = listTables(sqlite)
    if ("optional" in spec && spec.optional && !tables.has(spec.table)) continue

    const minimum = spec.unit === "milliseconds" ? 100_000_000_000 : 100_000_000
    const maximum = spec.unit === "milliseconds" ? 253_402_300_799_999 : 253_402_300_799
    const row = sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM main.${quoteIdentifier(spec.table)}
      WHERE ${quoteIdentifier(spec.column)} IS NOT NULL
        AND (
          ${quoteIdentifier(spec.column)} < ?
          OR ${quoteIdentifier(spec.column)} > ?
        )
    `).get(minimum, maximum) as { count: number }

    if (Number(row.count) > 0) {
      invalid.push({ ...spec, rows: Number(row.count) })
    }
  }

  if (invalid.length > 0) {
    throw new ImportError(
      "TIMESTAMP_RANGE_MISMATCH",
      "Imported timestamps do not match the expected seconds/milliseconds units",
      { invalid },
    )
  }

  return { checkedColumns: TIMESTAMP_COLUMNS.length, invalidRows: 0 }
}

function hashMessageSample(
  sqlite: Database.Database,
  schema: string,
  sourceColumns?: Set<string>,
) {
  const columns = TABLES.find(({ name }) => name === "message")!.columns
  const selections = columns.map((column) => {
    const expression = sourceColumns
      ? sourceExpression("message", column, sourceColumns)
      : quoteIdentifier(column)
    return `${expression} AS ${quoteIdentifier(column)}`
  }).join(", ")
  const rows = sqlite.prepare(`
    SELECT ${selections}
    FROM ${quoteIdentifier(schema)}.${quoteIdentifier("message")}
    ORDER BY ${quoteIdentifier("id")}
    LIMIT 25
  `).all()
  return {
    rows: rows.length,
    sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
  }
}

function main() {
  const startedAt = Date.now()
  const { force, sourceArgument } = parseArguments(process.argv.slice(2))
  const sourcePath = realpathSync(resolve(process.cwd(), sourceArgument))
  const targetPath = realpathSync(resolveDatabasePath())

  if (sourcePath === targetPath) {
    throw new ImportError(
      "SOURCE_EQUALS_TARGET",
      "Source and target SQLite files must be different",
    )
  }

  const source = new Database(sourcePath, { readonly: true, fileMustExist: true })
  const target = new Database(targetPath, { fileMustExist: true, timeout: 5_000 })

  try {
    target.pragma("busy_timeout = 5000")
    target.pragma("foreign_keys = ON")
    validateTargetSchema(target)
    const { columnsByTable, tables: sourceTables } = inspectSourceSchema(source)
    validateSourceEmailAddresses(source)
    validateSourceEmperor(source)

    target.prepare(`ATTACH DATABASE ? AS ${quoteIdentifier(SOURCE_SCHEMA)}`).run(sourcePath)
    try {
      const runImport = target.transaction(() => {
        const targetBefore = Object.fromEntries(
          TABLES.map(({ name }) => [name, countRows(target, "main", name)]),
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
          for (const { name } of DELETE_ORDER) {
            clearedRows += target
              .prepare(`DELETE FROM main.${quoteIdentifier(name)}`)
              .run().changes
          }
        }

        const results: TableResult[] = []
        for (const table of TABLES) {
          if (!sourceTables.has(table.name)) {
            results.push({
              table: table.name,
              sourcePresent: false,
              sourceRows: 0,
              insertedRows: 0,
              targetRows: countRows(target, "main", table.name),
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

          const targetColumns = table.columns.map(quoteIdentifier).join(", ")
          const sourceExpressions = table.columns
            .map((column) => sourceExpression(table.name, column, sourceColumns))
            .join(", ")
          const sourceRows = countRows(target, SOURCE_SCHEMA, table.name)
          const insertedRows = target.prepare(`
            INSERT INTO main.${quoteIdentifier(table.name)} (${targetColumns})
            SELECT ${sourceExpressions}
            FROM ${quoteIdentifier(SOURCE_SCHEMA)}.${quoteIdentifier(table.name)}
          `).run().changes
          const targetRows = countRows(target, "main", table.name)

          if (insertedRows !== sourceRows || targetRows !== sourceRows) {
            throw new ImportError(
              "ROW_COUNT_MISMATCH",
              `Row count verification failed for table ${table.name}`,
              { insertedRows, sourceRows, table: table.name, targetRows },
            )
          }

          results.push({
            table: table.name,
            sourcePresent: true,
            sourceRows,
            insertedRows,
            targetRows,
          })
        }

        const foreignKeyViolations = target.pragma("foreign_key_check") as unknown[]
        if (foreignKeyViolations.length > 0) {
          throw new ImportError(
            "FOREIGN_KEY_VIOLATION",
            "Imported data violates target foreign keys",
            { foreignKeyViolations },
          )
        }

        const timestampValidation = validateTimestampRanges(target)
        const sourceMessageHash = hashMessageSample(
          target,
          SOURCE_SCHEMA,
          columnsByTable.get("message"),
        )
        const targetMessageHash = hashMessageSample(target, "main")
        if (sourceMessageHash.sha256 !== targetMessageHash.sha256) {
          throw new ImportError(
            "MESSAGE_SAMPLE_MISMATCH",
            "Imported message sample does not match the source",
            { sourceMessageHash, targetMessageHash },
          )
        }

        return {
          clearedRows,
          results,
          timestampValidation,
          messageSample: targetMessageHash,
        }
      })

      const { clearedRows, results, timestampValidation, messageSample } = runImport.immediate()
      const messageColumns = columnsByTable.get("message")!

      return {
        event: "sqlite.d1_import.ok",
        source: sourcePath,
        target: targetPath,
        force,
        clearedRows,
        durationMs: Date.now() - startedAt,
        messageCompatibility: {
          defaultedToAddress: !messageColumns.has("to_address"),
          defaultedType: !messageColumns.has("type"),
          defaultedSentAt: !messageColumns.has("sent_at"),
        },
        foreignKeyViolations: 0,
        timestampValidation,
        messageSample,
        tables: results,
      }
    } finally {
      target.prepare(`DETACH DATABASE ${quoteIdentifier(SOURCE_SCHEMA)}`).run()
    }
  } finally {
    target.close()
    source.close()
  }
}

await requireValidatedRuntimeConfig("SQLite D1 import")

try {
  console.log(JSON.stringify(main()))
} catch (error) {
  const importError = error instanceof ImportError ? error : null
  const systemCode = error && typeof error === "object" && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null
  console.error(JSON.stringify({
    event: "sqlite.d1_import.error",
    code: importError?.code || systemCode || "UNEXPECTED_ERROR",
    message: error instanceof Error ? error.message : String(error),
    details: importError?.details,
  }))
  process.exitCode = 1
}
