import { requireValidatedRuntimeConfig } from "../ops/validated-runtime"

const config = await requireValidatedRuntimeConfig("database verification")
await import(config.database.driver === "postgres" ? "../postgres/verify" : "../sqlite/verify")
