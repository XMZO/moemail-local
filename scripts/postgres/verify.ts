import {
  closeDatabase,
  getDatabaseDriver,
  getPostgresPool,
} from "../../app/lib/db"
import { verifyPostgres } from "./lib"
import { requireValidatedRuntimeConfig } from "../ops/validated-runtime"

await requireValidatedRuntimeConfig("PostgreSQL verification")

if (getDatabaseDriver() !== "postgres") {
  throw new Error("请先在 data/config.yaml 中选择 PostgreSQL")
}

try {
  const verification = await verifyPostgres(getPostgresPool())
  console.log(JSON.stringify({
    event: "postgres.verify.ok",
    ...verification,
  }))
} finally {
  await closeDatabase()
}
