import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { closeDatabase } from "../../app/lib/db"
import { readConfigFile } from "../../app/lib/config/file"
import {
  configFingerprint,
  getConfig,
  getConfigPath,
  reloadConfig,
  saveConfig,
} from "../../app/lib/config/runtime"

const [probeId, pollValueRaw] = process.argv.slice(2)
const pollValue = Number(pollValueRaw)
if (!probeId || !Number.isInteger(pollValue)) {
  throw new Error("usage: runtime-config-cas-probe <id> <poll-ms>")
}

const loaded = await reloadConfig()
if (!loaded.ok) throw new Error("probe could not load the initial configuration")
const snapshot = readConfigFile(getConfigPath())
if (!snapshot) throw new Error("probe configuration is missing")
const fingerprint = configFingerprint(snapshot.raw)

const readyPath = join(process.cwd(), "data", `cas-ready-${probeId}`)
const peerPath = join(process.cwd(), "data", `cas-ready-${probeId === "a" ? "b" : "a"}`)
writeFileSync(readyPath, "ready\n", "utf8")

const deadline = Date.now() + 15_000
while (!existsSync(peerPath)) {
  if (Date.now() >= deadline) throw new Error("CAS peer did not reach the barrier")
  await new Promise(resolve => setTimeout(resolve, 25))
}

const current = getConfig()
const result = await saveConfig({
  ...current,
  server: { ...current.server, emailPollIntervalMs: pollValue },
}, { expectedFingerprint: fingerprint })

await closeDatabase()
console.log(`__MOEMAIL_CAS_PROBE__${JSON.stringify({
  id: probeId,
  ok: result.ok,
  conflict: !result.ok && result.issues.some(issue => issue.path === "(fingerprint)"),
})}`)
