import assert from "node:assert/strict"
import {
  getConfig,
  getConfigStatus,
  reloadConfig,
} from "../../app/lib/config/runtime"
import {
  createInitialEmperor,
  listEmperorCredentials,
  runMigrations,
} from "../../app/lib/database-setup"
import { closeDatabase } from "../../app/lib/db"
import { hashPassword, verifyPassword } from "../../app/lib/password"
import { completeSetup } from "../../app/lib/setup-service"

const mode = process.argv[2]
if (!new Set(["normal", "resume", "conflict"]).has(mode)) {
  throw new Error("mode must be normal, resume, or conflict")
}

const ownerPassword = "a-valid-owner-password-12345"
if (mode !== "normal") {
  const loaded = await reloadConfig()
  assert.equal(loaded.ok, true)
  const staged = getConfig()
  await runMigrations(staged)
  const passwordHash = await hashPassword(ownerPassword, staged.auth.passwordPepper ?? "")
  assert.equal(await createInitialEmperor(staged, {
    username: "existing-owner",
    passwordHash,
  }), "created")
}

const outcome = await completeSetup({
  config: {
    server: { baseUrl: "http://127.0.0.1:3000" },
    database: { driver: "sqlite", sqlite: { path: "data/setup.db" } },
  },
  advancedYaml: "scheduler:\n  cleanupIntervalSeconds: 120\n",
  admin: mode === "conflict"
    ? { username: "different-owner", password: ownerPassword }
    : {
      username: mode === "normal" ? "new-owner" : "existing-owner",
      password: ownerPassword,
    },
})

const status = getConfigStatus()
let passwordStillWorks: boolean | null = null
if (mode !== "conflict") {
  assert.equal(outcome.ok, true)
  assert.equal(status.setupCompleted, true)
  const config = getConfig()
  assert.equal(config.scheduler.cleanupIntervalSeconds, 120)
  const owners = await listEmperorCredentials(config)
  assert.equal(owners.length, 1)
  const verification = await verifyPassword(ownerPassword, owners[0].passwordHash ?? "", {
    passwordPepper: config.auth.passwordPepper ?? "",
    legacyAuthSecret: config.auth.secret ?? "",
  })
  passwordStillWorks = verification.valid
  assert.equal(passwordStillWorks, true)
  if (outcome.ok) {
    assert.equal(outcome.adminCreated, mode === "normal")
  }
} else {
  assert.equal(outcome.ok, false)
  assert.equal(outcome.status, 409)
  assert.equal(status.setupCompleted, false)
}

await closeDatabase()
console.log(`__MOEMAIL_SETUP_PROBE__${JSON.stringify({
  mode,
  ok: outcome.ok,
  status: outcome.ok ? 200 : outcome.status,
  setupCompleted: status.setupCompleted,
  passwordStillWorks,
})}`)
