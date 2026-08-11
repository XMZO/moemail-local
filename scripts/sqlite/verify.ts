import { resolveDatabasePath, verifyDatabase } from "./lib"
import { requireValidatedRuntimeConfig } from "../ops/validated-runtime"

await requireValidatedRuntimeConfig("SQLite verification")

const databasePath = resolveDatabasePath(process.argv[2])
const result = verifyDatabase(databasePath)

console.log(JSON.stringify({
  event: "sqlite.verify.ok",
  databasePath,
  ...result,
}))
