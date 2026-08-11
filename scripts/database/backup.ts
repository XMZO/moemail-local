import { requireValidatedRuntimeConfig } from "../ops/validated-runtime"

const config = await requireValidatedRuntimeConfig("database backup")
await import(config.database.driver === "postgres" ? "../postgres/backup" : "../sqlite/backup")
