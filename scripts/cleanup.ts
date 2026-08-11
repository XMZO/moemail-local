import { requireValidatedRuntimeConfig } from "./ops/validated-runtime"

const config = await requireValidatedRuntimeConfig("database cleanup")
if (config.database.driver === "postgres") {
  await import("./postgres/cleanup")
} else {
  await import("./sqlite/cleanup")
}
