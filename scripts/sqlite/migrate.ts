import { migrate } from "drizzle-orm/better-sqlite3/migrator"
import { resolve } from "node:path"
import { createDb, getDatabasePath, getSqlite } from "../../app/lib/db"
import { requireValidatedRuntimeConfig } from "../ops/validated-runtime"

await requireValidatedRuntimeConfig("SQLite migration")

const sqlite = getSqlite()
const foreignKeysEnabled = sqlite.pragma("foreign_keys", { simple: true }) === 1

try {
  sqlite.pragma("foreign_keys = OFF")
  migrate(createDb(), {
    migrationsFolder: resolve(process.cwd(), "drizzle-local"),
  })
} finally {
  sqlite.pragma(`foreign_keys = ${foreignKeysEnabled ? "ON" : "OFF"}`)
}

const foreignKeyViolations = sqlite.pragma("foreign_key_check") as unknown[]
if (foreignKeyViolations.length > 0) {
  console.error("SQLite foreign key validation failed", foreignKeyViolations)
  process.exit(1)
}

const integrityRows = sqlite.pragma("integrity_check") as Array<{
  integrity_check: string
}>
if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== "ok") {
  console.error("SQLite integrity validation failed", integrityRows)
  process.exit(1)
}

console.log(`SQLite migrations applied: ${getDatabasePath()}`)
