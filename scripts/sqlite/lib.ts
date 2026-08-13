import Database from "better-sqlite3"
import { resolve } from "node:path"
import { getConfig } from "../../app/lib/config/runtime"
import { normalizeMailboxAddress } from "../../app/lib/email-address"

const REQUIRED_TABLES = [
  "__drizzle_migrations",
  "account",
  "api_keys",
  "email",
  "email_share",
  "mailbox_name_block",
  "message",
  "message_share",
  "role",
  "send_quota_event",
  "site_config",
  "user",
  "user_role",
  "webhook",
] as const

type RequiredTable = (typeof REQUIRED_TABLES)[number]

const REQUIRED_COLUMNS: Record<RequiredTable, readonly string[]> = {
  __drizzle_migrations: ["id", "hash", "created_at"],
  account: [
    "userId", "type", "provider", "providerAccountId", "refresh_token",
    "access_token", "expires_at", "token_type", "scope", "id_token",
    "session_state",
  ],
  api_keys: ["id", "user_id", "name", "key", "created_at", "expires_at", "enabled"],
  email: ["id", "address", "userId", "created_at", "expires_at"],
  email_share: ["id", "email_id", "token", "created_at", "expires_at"],
  mailbox_name_block: ["id", "user_id", "scope_key", "local_part", "domain", "created_at"],
  message: [
    "id", "emailId", "from_address", "to_address", "subject", "content",
    "html", "type", "received_at", "sent_at",
  ],
  message_share: ["id", "message_id", "token", "created_at", "expires_at"],
  role: ["id", "name", "description", "created_at", "updated_at"],
  send_quota_event: ["id", "user_id", "quota_subject", "policy_role", "direction", "sender_domain", "mailbox_address", "global_rule_id", "scoped_rule_id", "status", "created_at", "reservation_expires_at", "completed_at"],
  site_config: ["key", "value", "updated_at"],
  user: ["id", "name", "email", "emailVerified", "image", "username", "password"],
  user_role: ["user_id", "role_id", "created_at"],
  webhook: ["id", "user_id", "url", "enabled", "created_at", "updated_at"],
}

const REQUIRED_PRIMARY_KEYS: Record<RequiredTable, readonly string[]> = {
  __drizzle_migrations: ["id"],
  account: ["provider", "providerAccountId"],
  api_keys: ["id"],
  email: ["id"],
  email_share: ["id"],
  mailbox_name_block: ["id"],
  message: ["id"],
  message_share: ["id"],
  role: ["id"],
  send_quota_event: ["id"],
  site_config: ["key"],
  user: ["id"],
  user_role: ["user_id", "role_id"],
  webhook: ["id"],
}

const REQUIRED_INDEXES = [
  { table: "account", name: "account_user_id_idx", unique: false, columns: ["userId"] },
  { table: "api_keys", name: "api_keys_key_unique", unique: true, columns: ["key"] },
  { table: "api_keys", name: "name_user_id_unique", unique: true, columns: ["name", "user_id"] },
  { table: "api_keys", name: "api_keys_user_id_idx", unique: false, columns: ["user_id"] },
  { table: "email_share", name: "email_share_token_unique", unique: true, columns: ["token"] },
  { table: "email_share", name: "email_share_email_id_idx", unique: false, columns: ["email_id"] },
  { table: "email_share", name: "email_share_token_idx", unique: false, columns: ["token"] },
  { table: "email", name: "email_address_unique", unique: true, columns: ["address"] },
  { table: "email", name: "email_expires_at_idx", unique: false, columns: ["expires_at"] },
  { table: "email", name: "email_user_id_idx", unique: false, columns: ["userId"] },
  { table: "email", name: "email_address_lower_idx", unique: true, expression: /\(\s*LOWER\s*\(\s*["`]?address["`]?\s*\)\s*\)\s*;?\s*$/i },
  { table: "message_share", name: "message_share_token_unique", unique: true, columns: ["token"] },
  { table: "message_share", name: "message_share_message_id_idx", unique: false, columns: ["message_id"] },
  { table: "message_share", name: "message_share_token_idx", unique: false, columns: ["token"] },
  { table: "message", name: "message_email_id_idx", unique: false, columns: ["emailId"] },
  { table: "message", name: "message_email_id_received_at_type_idx", unique: false, columns: ["emailId", "received_at", "type"] },
  { table: "mailbox_name_block", name: "mailbox_name_block_scope_unique", unique: true, columns: ["scope_key", "local_part", "domain"] },
  { table: "mailbox_name_block", name: "mailbox_name_block_lookup_idx", unique: false, columns: ["local_part", "domain", "scope_key"] },
  { table: "send_quota_event", name: "send_quota_event_subject_created_idx", unique: false, columns: ["quota_subject", "created_at"] },
  { table: "send_quota_event", name: "send_quota_event_subject_domain_created_idx", unique: false, columns: ["quota_subject", "sender_domain", "created_at"] },
  { table: "send_quota_event", name: "send_quota_event_subject_direction_created_idx", unique: false, columns: ["quota_subject", "direction", "created_at"] },
  { table: "send_quota_event", name: "send_quota_event_subject_direction_domain_created_idx", unique: false, columns: ["quota_subject", "direction", "sender_domain", "created_at"] },
  { table: "send_quota_event", name: "send_quota_event_user_direction_mailbox_created_idx", unique: false, columns: ["user_id", "direction", "mailbox_address", "created_at"] },
  { table: "send_quota_event", name: "send_quota_event_user_created_idx", unique: false, columns: ["user_id", "created_at"] },
  { table: "send_quota_event", name: "send_quota_event_role_created_idx", unique: false, columns: ["policy_role", "created_at"] },
  { table: "send_quota_event", name: "send_quota_event_global_rule_created_idx", unique: false, columns: ["global_rule_id", "created_at"] },
  { table: "send_quota_event", name: "send_quota_event_scoped_rule_created_idx", unique: false, columns: ["scoped_rule_id", "created_at"] },
  { table: "send_quota_event", name: "send_quota_event_scoped_rule_user_created_idx", unique: false, columns: ["scoped_rule_id", "user_id", "created_at"] },
  { table: "user_role", name: "user_role_user_id_idx", unique: false, columns: ["user_id"] },
  { table: "user", name: "user_email_unique", unique: true, columns: ["email"] },
  { table: "user", name: "user_username_unique", unique: true, columns: ["username"] },
  { table: "webhook", name: "webhook_user_id_idx", unique: false, columns: ["user_id"] },
] as const

const REQUIRED_FOREIGN_KEYS = [
  { table: "account", from: "userId", referencedTable: "user", to: "id", onDelete: "CASCADE" },
  { table: "api_keys", from: "user_id", referencedTable: "user", to: "id", onDelete: "NO ACTION" },
  { table: "email_share", from: "email_id", referencedTable: "email", to: "id", onDelete: "CASCADE" },
  { table: "email", from: "userId", referencedTable: "user", to: "id", onDelete: "CASCADE" },
  { table: "message_share", from: "message_id", referencedTable: "message", to: "id", onDelete: "CASCADE" },
  { table: "message", from: "emailId", referencedTable: "email", to: "id", onDelete: "CASCADE" },
  { table: "mailbox_name_block", from: "user_id", referencedTable: "user", to: "id", onDelete: "CASCADE" },
  { table: "send_quota_event", from: "user_id", referencedTable: "user", to: "id", onDelete: "SET NULL" },
  { table: "user_role", from: "user_id", referencedTable: "user", to: "id", onDelete: "CASCADE" },
  { table: "user_role", from: "role_id", referencedTable: "role", to: "id", onDelete: "CASCADE" },
  { table: "webhook", from: "user_id", referencedTable: "user", to: "id", onDelete: "CASCADE" },
] as const

function missing(actual: Iterable<string>, required: readonly string[]) {
  const actualSet = new Set(actual)
  return required.filter(value => !actualSet.has(value))
}

export function resolveDatabasePath(configuredPath = getConfig().database.sqlite.path) {
  const databasePath = configuredPath.trim()
  if (databasePath === ":memory:") {
    throw new Error("This command requires a file-backed SQLite database")
  }

  return resolve(process.cwd(), databasePath)
}

export function verifyDatabase(databasePath: string) {
  const sqlite = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  })

  try {
    const integrityRows = sqlite.pragma("integrity_check") as Array<{
      integrity_check: string
    }>
    if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== "ok") {
      throw new Error(`SQLite integrity_check failed: ${JSON.stringify(integrityRows)}`)
    }

    const foreignKeyViolations = sqlite.pragma("foreign_key_check") as unknown[]
    if (foreignKeyViolations.length > 0) {
      throw new Error(
        `SQLite foreign_key_check failed: ${JSON.stringify(foreignKeyViolations)}`,
      )
    }

    const tableRows = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
    const tableNames = new Set(tableRows.map(({ name }) => name))
    const missingTables = REQUIRED_TABLES.filter((table) => !tableNames.has(table))
    if (missingTables.length > 0) {
      throw new Error(`SQLite database is missing tables: ${missingTables.join(", ")}`)
    }

    for (const table of REQUIRED_TABLES) {
      const columns = sqlite.pragma(`table_info('${table}')`) as Array<{
        name: string
        pk: number
      }>
      const missingColumns = missing(columns.map(column => column.name), REQUIRED_COLUMNS[table])
      if (missingColumns.length > 0) {
        throw new Error(`SQLite table ${table} is missing columns: ${missingColumns.join(", ")}`)
      }
      const primaryKey = columns
        .filter(column => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map(column => column.name)
      if (JSON.stringify(primaryKey) !== JSON.stringify(REQUIRED_PRIMARY_KEYS[table])) {
        throw new Error(`SQLite table ${table} primary key is invalid`)
      }
    }

    const indexCountByName = new Map<string, {
      table: string
      unique: boolean
      partial: boolean
    }>()
    for (const table of REQUIRED_TABLES) {
      const indexes = sqlite.pragma(`index_list('${table}')`) as Array<{
        name: string
        unique: number
        partial: number
      }>
      for (const index of indexes) {
        indexCountByName.set(index.name, {
          table,
          unique: index.unique === 1,
          partial: index.partial === 1,
        })
      }
    }
    for (const required of REQUIRED_INDEXES) {
      const actual = indexCountByName.get(required.name)
      if (!actual || actual.table !== required.table) {
        throw new Error(`SQLite database is missing index: ${required.name}`)
      }
      if (actual.unique !== required.unique) {
        throw new Error(`SQLite index ${required.name} unique property is invalid`)
      }
      if ("columns" in required) {
        const rows = sqlite.pragma(`index_info('${required.name}')`) as Array<{
          seqno: number
          name: string | null
        }>
        const columns = rows.sort((left, right) => left.seqno - right.seqno).map(row => row.name)
        if (JSON.stringify(columns) !== JSON.stringify(required.columns)) {
          throw new Error(`SQLite index ${required.name} columns are invalid`)
        }
      } else {
        if (actual.partial) {
          throw new Error(`SQLite index ${required.name} partial property is invalid`)
        }
        const row = sqlite.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
        ).get(required.name) as { sql: string | null } | undefined
        const keyParts = sqlite.pragma(`index_xinfo('${required.name}')`) as Array<{
          cid: number
          key: number
          name: string | null
        }>
        const expressionParts = keyParts.filter(part => part.key === 1)
        if (
          !row?.sql
          || !required.expression.test(row.sql)
          || expressionParts.length !== 1
          || expressionParts[0].cid !== -2
          || expressionParts[0].name !== null
        ) {
          throw new Error(`SQLite index ${required.name} expression is invalid`)
        }
      }
    }

    for (const required of REQUIRED_FOREIGN_KEYS) {
      const rows = sqlite.pragma(`foreign_key_list('${required.table}')`) as Array<{
        table: string
        from: string
        to: string
        on_delete: string
      }>
      const found = rows.some(row => (
        row.table === required.referencedTable
        && row.from === required.from
        && row.to === required.to
        && row.on_delete.toUpperCase() === required.onDelete
      ))
      if (!found) {
        throw new Error(
          `SQLite table ${required.table} is missing foreign key ${required.from} -> ${required.referencedTable}.${required.to}`,
        )
      }
    }

    const emailIndexes = sqlite.pragma("index_list('email')") as Array<{
      name: string
      unique: number
    }>
    const lowerAddressIndex = emailIndexes.find(
      index => index.name === "email_address_lower_idx",
    )
    if (!lowerAddressIndex || lowerAddressIndex.unique !== 1) {
      throw new Error("SQLite email_address_lower_idx must be unique")
    }

    const emailRows = sqlite.prepare(`
      SELECT id, address
      FROM email
      ORDER BY id
    `).all() as Array<{ id: string; address: unknown }>
    const normalizedAddresses = new Set<string>()
    for (const row of emailRows) {
      const normalizedAddress = normalizeMailboxAddress(row.address)
      if (!normalizedAddress) {
        throw new Error(`SQLite email ${row.id} has an unsupported mailbox address`)
      }
      if (normalizedAddresses.has(normalizedAddress)) {
        throw new Error(`SQLite database contains duplicate mailbox address ${normalizedAddress}`)
      }
      normalizedAddresses.add(normalizedAddress)
    }

    const emperorUsers = sqlite.prepare(`
      SELECT COUNT(DISTINCT user_role.user_id) AS count
      FROM user_role
      INNER JOIN role ON role.id = user_role.role_id
      WHERE role.name = 'emperor'
    `).get() as { count: number }
    if (Number(emperorUsers.count) > 1) {
      throw new Error("SQLite database contains multiple emperor users")
    }

    const counts = Object.fromEntries(
      ["user", "email", "message", "site_config"].map((table) => {
        const row = sqlite.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as {
          count: number
        }
        return [table, Number(row.count)]
      }),
    )

    return {
      counts,
      tables: tableNames.size,
      indexes: REQUIRED_INDEXES.length,
      foreignKeys: REQUIRED_FOREIGN_KEYS.length,
      securityInvariants: {
        asciiMailboxAddresses: true,
        caseInsensitiveEmailUnique: true,
        emperorUsers: Number(emperorUsers.count),
      },
    }
  } finally {
    sqlite.close()
  }
}
