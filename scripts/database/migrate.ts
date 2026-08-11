import { requireValidatedRuntimeConfig } from "../ops/validated-runtime"

const config = await requireValidatedRuntimeConfig("database migration")
await import(config.database.driver === "postgres" ? "../postgres/migrate" : "../sqlite/migrate")
