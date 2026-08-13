import assert from "node:assert/strict"
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import Database from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { migrate } from "drizzle-orm/better-sqlite3/migrator"

type Journal = {
  version: string
  dialect: string
  entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>
}

const repositoryMigrations = resolve(process.cwd(), "drizzle-local")
const sandbox = mkdtempSync(join(tmpdir(), "moemail-policy-migrations-"))
const legacyMigrations = join(sandbox, "legacy-migrations")
const databasePath = join(sandbox, "legacy.db")
let sqlite: InstanceType<typeof Database> | undefined

try {
  const journal = JSON.parse(readFileSync(join(repositoryMigrations, "meta", "_journal.json"), "utf8")) as Journal
  const legacyEntries = journal.entries.filter(entry => entry.idx <= 1)
  assert.deepEqual(legacyEntries.map(entry => entry.tag), [
    "0000_curious_mentor",
    "0001_send_quota_events",
  ])

  mkdirSync(join(legacyMigrations, "meta"), { recursive: true })
  writeFileSync(
    join(legacyMigrations, "meta", "_journal.json"),
    `${JSON.stringify({ ...journal, entries: legacyEntries }, null, 2)}\n`,
    { mode: 0o600 },
  )
  for (const entry of legacyEntries) {
    copyFileSync(
      join(repositoryMigrations, `${entry.tag}.sql`),
      join(legacyMigrations, `${entry.tag}.sql`),
    )
  }

  sqlite = new Database(databasePath)
  sqlite.pragma("foreign_keys = ON")
  migrate(drizzle(sqlite), { migrationsFolder: legacyMigrations })
  sqlite.prepare("INSERT INTO user (id, username) VALUES (?, ?)").run("legacy-user", "legacy")
  sqlite.prepare(`
    INSERT INTO send_quota_event (
      id, user_id, quota_subject, policy_role, sender_domain, status,
      created_at, reservation_expires_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "legacy-event",
    "legacy-user",
    "user:legacy-user",
    "duke",
    "legacy.example",
    "sent",
    1_786_560_000_000,
    1_786_560_060_000,
    1_786_560_001_000,
  )

  // Match the production migration entrypoint: SQLite cannot change the
  // foreign_keys pragma from inside Drizzle's migration transaction.
  sqlite.pragma("foreign_keys = OFF")
  migrate(drizzle(sqlite), { migrationsFolder: repositoryMigrations })
  sqlite.pragma("foreign_keys = ON")

  const migrated = sqlite.prepare(`
    SELECT id, user_id, quota_subject, policy_role, direction, sender_domain,
      mailbox_address, status, created_at, reservation_expires_at, completed_at
    FROM send_quota_event WHERE id = ?
  `).get("legacy-event") as Record<string, unknown>
  assert.deepEqual(migrated, {
    id: "legacy-event",
    user_id: "legacy-user",
    quota_subject: "user:legacy-user",
    policy_role: "duke",
    direction: "send",
    sender_domain: "legacy.example",
    mailbox_address: "",
    status: "sent",
    created_at: 1_786_560_000_000,
    reservation_expires_at: 1_786_560_060_000,
    completed_at: 1_786_560_001_000,
  })

  const tables = new Set(
    (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map(row => row.name),
  )
  assert(tables.has("mailbox_name_block"))

  const indexes = new Set(
    (sqlite.prepare("PRAGMA index_list('send_quota_event')").all() as Array<{ name: string }>)
      .map(row => row.name),
  )
  for (const name of [
    "send_quota_event_subject_direction_created_idx",
    "send_quota_event_subject_direction_domain_created_idx",
    "send_quota_event_user_direction_mailbox_created_idx",
  ]) assert(indexes.has(name), `missing migrated index: ${name}`)

  assert.throws(() => sqlite?.prepare(`
    INSERT INTO send_quota_event (
      id, quota_subject, policy_role, direction, sender_domain, mailbox_address,
      status, created_at, reservation_expires_at
    ) VALUES ('invalid-direction', 'user:x', 'duke', 'other', 'example.test', '', 'sent', 1, 1)
  `).run(), /CHECK constraint failed/)

  sqlite.prepare("DELETE FROM user WHERE id = ?").run("legacy-user")
  assert.equal(
    (sqlite.prepare("SELECT user_id FROM send_quota_event WHERE id = ?").get("legacy-event") as { user_id: string | null }).user_id,
    null,
  )
  assert.deepEqual(sqlite.pragma("foreign_key_check"), [])
  assert.deepEqual(sqlite.pragma("integrity_check"), [{ integrity_check: "ok" }])

  const applied = sqlite.prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations").get() as { count: number }
  assert.equal(applied.count, journal.entries.length)

  console.log(JSON.stringify({
    legacyQuotaHistoryPreserved: true,
    sendDirectionBackfilled: true,
    mailboxBlockSchemaInstalled: true,
    quotaIndexesInstalled: true,
    userDeletionPreservesHistory: true,
    migrationJournalComplete: true,
  }))
} finally {
  sqlite?.close()
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
