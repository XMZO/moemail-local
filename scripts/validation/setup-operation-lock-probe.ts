import { existsSync, writeFileSync } from "node:fs"
import { acquireSetupOperation } from "../../app/lib/setup-service"

const holdMs = Number.parseInt(process.argv[2] ?? "0", 10)
const readyPath = process.argv[3]
const release = acquireSetupOperation()

if (!release) {
  console.log("__MOEMAIL_SETUP_LOCK_PROBE__" + JSON.stringify({ acquired: false }))
  process.exit(0)
}

try {
  if (readyPath && !existsSync(readyPath)) writeFileSync(readyPath, "ready", "utf8")
  if (holdMs > 0) await new Promise(resolve => setTimeout(resolve, holdMs))
} finally {
  release()
}

console.log("__MOEMAIL_SETUP_LOCK_PROBE__" + JSON.stringify({ acquired: true }))
