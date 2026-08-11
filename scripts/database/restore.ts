import { existsSync, realpathSync } from "node:fs"
import { resolve } from "node:path"
import { loadBackupConfigSnapshot } from "../ops/trusted-config"

const sourceArgument = process.argv[2]
if (!sourceArgument) {
  throw new Error("Usage: pnpm db:restore <backup> --force")
}

const unresolvedSource = resolve(process.cwd(), sourceArgument)
if (!existsSync(unresolvedSource)) {
  throw new Error(`Backup file does not exist: ${unresolvedSource}`)
}
const config = loadBackupConfigSnapshot(realpathSync(unresolvedSource))
await import(config.database.driver === "postgres" ? "../postgres/restore" : "../sqlite/restore")
