import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import {
  closeDatabase,
  getDatabaseDriver,
  getPostgresPool,
} from "../../app/lib/db"
import * as localSchema from "../../app/lib/local-schema.postgres"
import * as schema from "../../app/lib/schema.postgres"
import { verifyPostgres } from "./lib"
import { requireValidatedRuntimeConfig } from "../ops/validated-runtime"

await requireValidatedRuntimeConfig("PostgreSQL migration")

if (getDatabaseDriver() !== "postgres") {
  throw new Error("请先在 data/config.yaml 中选择 PostgreSQL")
}

const pool = getPostgresPool()
const client = await pool.connect()

try {
  await client.query("SELECT pg_advisory_lock(hashtext('moemail:migrate'))")
  try {
    const db = drizzle(client, { schema: { ...schema, ...localSchema } })
    await migrate(db, { migrationsFolder: "drizzle-postgres" })
    const verification = await verifyPostgres(client)
    console.log(JSON.stringify({
      event: "postgres.migrate.ok",
      ...verification,
    }))
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('moemail:migrate'))")
  }
} finally {
  client.release()
  await closeDatabase()
}
