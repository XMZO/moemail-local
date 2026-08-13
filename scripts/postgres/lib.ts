import type { Pool, PoolClient, QueryResultRow } from "pg"
import { normalizeMailboxAddress } from "../../app/lib/email-address"

type Queryable = Pick<Pool | PoolClient, "query">

export const POSTGRES_TABLES = [
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

const REQUIRED_COLUMNS: Record<(typeof POSTGRES_TABLES)[number], readonly string[]> = {
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
  send_quota_event: ["id", "user_id", "quota_subject", "policy_role", "direction", "sender_domain", "mailbox_address", "status", "created_at", "reservation_expires_at", "completed_at"],
  site_config: ["key", "value", "updated_at"],
  user: ["id", "name", "email", "emailVerified", "image", "username", "password"],
  user_role: ["user_id", "role_id", "created_at"],
  webhook: ["id", "user_id", "url", "enabled", "created_at", "updated_at"],
}

const REQUIRED_KEY_CONSTRAINTS = [
  { name: "account_provider_providerAccountId_pk", table: "account", type: "p", columns: ["provider", "providerAccountId"] },
  { name: "api_keys_pkey", table: "api_keys", type: "p", columns: ["id"] },
  { name: "email_share_pkey", table: "email_share", type: "p", columns: ["id"] },
  { name: "email_pkey", table: "email", type: "p", columns: ["id"] },
  { name: "message_share_pkey", table: "message_share", type: "p", columns: ["id"] },
  { name: "message_pkey", table: "message", type: "p", columns: ["id"] },
  { name: "mailbox_name_block_pkey", table: "mailbox_name_block", type: "p", columns: ["id"] },
  { name: "role_pkey", table: "role", type: "p", columns: ["id"] },
  { name: "send_quota_event_pkey", table: "send_quota_event", type: "p", columns: ["id"] },
  { name: "site_config_pkey", table: "site_config", type: "p", columns: ["key"] },
  { name: "user_role_user_id_role_id_pk", table: "user_role", type: "p", columns: ["user_id", "role_id"] },
  { name: "user_pkey", table: "user", type: "p", columns: ["id"] },
  { name: "webhook_pkey", table: "webhook", type: "p", columns: ["id"] },
  { name: "api_keys_key_unique", table: "api_keys", type: "u", columns: ["key"] },
  { name: "email_share_token_unique", table: "email_share", type: "u", columns: ["token"] },
  { name: "email_address_unique", table: "email", type: "u", columns: ["address"] },
  { name: "message_share_token_unique", table: "message_share", type: "u", columns: ["token"] },
  { name: "user_email_unique", table: "user", type: "u", columns: ["email"] },
  { name: "user_username_unique", table: "user", type: "u", columns: ["username"] },
] as const

const REQUIRED_INDEXES = [
  { name: "account_user_id_idx", table: "account", unique: false, expressions: ["userId"] },
  { name: "api_keys_user_id_idx", table: "api_keys", unique: false, expressions: ["user_id"] },
  { name: "email_address_lower_idx", table: "email", unique: true, expressions: ["lower(address)"] },
  { name: "email_expires_at_idx", table: "email", unique: false, expressions: ["expires_at"] },
  { name: "email_share_email_id_idx", table: "email_share", unique: false, expressions: ["email_id"] },
  { name: "email_share_token_idx", table: "email_share", unique: false, expressions: ["token"] },
  { name: "email_user_id_idx", table: "email", unique: false, expressions: ["userId"] },
  { name: "message_email_id_idx", table: "message", unique: false, expressions: ["emailId"] },
  { name: "message_email_id_received_at_type_idx", table: "message", unique: false, expressions: ["emailId", "received_at", "type"] },
  { name: "message_share_message_id_idx", table: "message_share", unique: false, expressions: ["message_id"] },
  { name: "message_share_token_idx", table: "message_share", unique: false, expressions: ["token"] },
  { name: "mailbox_name_block_scope_unique", table: "mailbox_name_block", unique: true, expressions: ["scope_key", "local_part", "domain"] },
  { name: "mailbox_name_block_lookup_idx", table: "mailbox_name_block", unique: false, expressions: ["local_part", "domain", "scope_key"] },
  { name: "send_quota_event_subject_created_idx", table: "send_quota_event", unique: false, expressions: ["quota_subject", "created_at"] },
  { name: "send_quota_event_subject_domain_created_idx", table: "send_quota_event", unique: false, expressions: ["quota_subject", "sender_domain", "created_at"] },
  { name: "send_quota_event_subject_direction_created_idx", table: "send_quota_event", unique: false, expressions: ["quota_subject", "direction", "created_at"] },
  { name: "send_quota_event_subject_direction_domain_created_idx", table: "send_quota_event", unique: false, expressions: ["quota_subject", "direction", "sender_domain", "created_at"] },
  { name: "send_quota_event_user_direction_mailbox_created_idx", table: "send_quota_event", unique: false, expressions: ["user_id", "direction", "mailbox_address", "created_at"] },
  { name: "send_quota_event_user_created_idx", table: "send_quota_event", unique: false, expressions: ["user_id", "created_at"] },
  { name: "send_quota_event_role_created_idx", table: "send_quota_event", unique: false, expressions: ["policy_role", "created_at"] },
  { name: "name_user_id_unique", table: "api_keys", unique: true, expressions: ["name", "user_id"] },
  { name: "user_role_user_id_idx", table: "user_role", unique: false, expressions: ["user_id"] },
  { name: "webhook_user_id_idx", table: "webhook", unique: false, expressions: ["user_id"] },
] as const

const REQUIRED_FOREIGN_KEYS = [
  { name: "account_userId_user_id_fk", table: "account", columns: ["userId"], referencedTable: "user", referencedColumns: ["id"], onDelete: "c" },
  { name: "api_keys_user_id_user_id_fk", table: "api_keys", columns: ["user_id"], referencedTable: "user", referencedColumns: ["id"], onDelete: "a" },
  { name: "email_share_email_id_email_id_fk", table: "email_share", columns: ["email_id"], referencedTable: "email", referencedColumns: ["id"], onDelete: "c" },
  { name: "email_userId_user_id_fk", table: "email", columns: ["userId"], referencedTable: "user", referencedColumns: ["id"], onDelete: "c" },
  { name: "message_share_message_id_message_id_fk", table: "message_share", columns: ["message_id"], referencedTable: "message", referencedColumns: ["id"], onDelete: "c" },
  { name: "message_emailId_email_id_fk", table: "message", columns: ["emailId"], referencedTable: "email", referencedColumns: ["id"], onDelete: "c" },
  { name: "mailbox_name_block_user_id_user_id_fk", table: "mailbox_name_block", columns: ["user_id"], referencedTable: "user", referencedColumns: ["id"], onDelete: "c" },
  { name: "send_quota_event_user_id_user_id_fk", table: "send_quota_event", columns: ["user_id"], referencedTable: "user", referencedColumns: ["id"], onDelete: "n" },
  { name: "user_role_role_id_role_id_fk", table: "user_role", columns: ["role_id"], referencedTable: "role", referencedColumns: ["id"], onDelete: "c" },
  { name: "user_role_user_id_user_id_fk", table: "user_role", columns: ["user_id"], referencedTable: "user", referencedColumns: ["id"], onDelete: "c" },
  { name: "webhook_user_id_user_id_fk", table: "webhook", columns: ["user_id"], referencedTable: "user", referencedColumns: ["id"], onDelete: "c" },
] as const

function normalizedIndexExpression(value: string) {
  return value.replace(/["\s]/g, "").toLowerCase()
}

function missing<T extends string>(actual: Iterable<string>, required: readonly T[]) {
  const actualSet = new Set(actual)
  return required.filter(value => !actualSet.has(value))
}

export async function verifyPostgres(database: Queryable) {
  const metadata = await database.query<{
    database_name: string
    server_version: string
  }>(`SELECT current_database() AS database_name, current_setting('server_version') AS server_version`)

  const tableRows = await database.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `)
  const missingTables = missing(
    tableRows.rows.map(row => row.table_name),
    POSTGRES_TABLES,
  )
  if (missingTables.length > 0) {
    throw new Error(`PostgreSQL database is missing tables: ${missingTables.join(", ")}`)
  }

  const columnRows = await database.query<{
    column_name: string
    table_name: string
  }>(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ANY($1::text[])
  `, [POSTGRES_TABLES])
  const columnsByTable = new Map<string, Set<string>>()
  for (const row of columnRows.rows) {
    const columns = columnsByTable.get(row.table_name) ?? new Set<string>()
    columns.add(row.column_name)
    columnsByTable.set(row.table_name, columns)
  }
  for (const table of POSTGRES_TABLES) {
    const missingColumns = missing(columnsByTable.get(table) ?? [], REQUIRED_COLUMNS[table])
    if (missingColumns.length > 0) {
      throw new Error(
        `PostgreSQL table ${table} is missing columns: ${missingColumns.join(", ")}`,
      )
    }
  }

  const migrationColumnRows = await database.query<{ column_name: string }>(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'drizzle'
      AND table_name = '__drizzle_migrations'
  `)
  const missingMigrationColumns = missing(
    migrationColumnRows.rows.map(row => row.column_name),
    ["id", "hash", "created_at"] as const,
  )
  if (missingMigrationColumns.length > 0) {
    throw new Error(
      `PostgreSQL table drizzle.__drizzle_migrations is missing columns: ${missingMigrationColumns.join(", ")}`,
    )
  }

  const migrationPrimaryKey = await database.query<{ columns: string[] }>(`
    SELECT ARRAY(
      SELECT source_column.attname::text
      FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, position)
      JOIN pg_attribute source_column
        ON source_column.attrelid = constraint_row.conrelid
       AND source_column.attnum = key_column.attnum
      ORDER BY key_column.position
    ) AS columns
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'drizzle.__drizzle_migrations'::regclass
      AND constraint_row.contype = 'p'
  `)
  if (
    migrationPrimaryKey.rows.length !== 1
    || JSON.stringify(migrationPrimaryKey.rows[0].columns) !== JSON.stringify(["id"])
  ) {
    throw new Error("PostgreSQL table drizzle.__drizzle_migrations primary key is invalid")
  }

  const keyConstraintRows = await database.query<{
    columns: string[]
    conname: string
    contype: string
    table_name: string
  }>(`
    SELECT
      constraint_row.conname,
      constraint_row.contype::text,
      source_table.relname AS table_name,
      ARRAY(
        SELECT source_column.attname::text
        FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, position)
        JOIN pg_attribute source_column
          ON source_column.attrelid = constraint_row.conrelid
         AND source_column.attnum = key_column.attnum
        ORDER BY key_column.position
      ) AS columns
    FROM pg_constraint constraint_row
    JOIN pg_class source_table ON source_table.oid = constraint_row.conrelid
    WHERE constraint_row.connamespace = 'public'::regnamespace
      AND constraint_row.contype IN ('p', 'u')
  `)
  for (const required of REQUIRED_KEY_CONSTRAINTS) {
    const actual = keyConstraintRows.rows.find(row => row.conname === required.name)
    if (
      !actual
      || actual.table_name !== required.table
      || actual.contype !== required.type
      || JSON.stringify(actual.columns) !== JSON.stringify(required.columns)
    ) {
      throw new Error(`PostgreSQL key constraint ${required.name} is missing or invalid`)
    }
  }

  const indexRows = await database.query<{
    expressions: string[]
    indexname: string
    table_name: string
    unique: boolean
  }>(`
    SELECT
      index_table.relname AS indexname,
      source_table.relname AS table_name,
      index_row.indisunique AS unique,
      ARRAY(
        SELECT COALESCE(
          source_column.attname::text,
          pg_get_indexdef(index_row.indexrelid, key_column.position::integer, true)
        )
        FROM unnest(index_row.indkey) WITH ORDINALITY AS key_column(attnum, position)
        LEFT JOIN pg_attribute source_column
          ON source_column.attrelid = index_row.indrelid
         AND source_column.attnum = key_column.attnum
        ORDER BY key_column.position
      ) AS expressions
    FROM pg_index index_row
    JOIN pg_class index_table ON index_table.oid = index_row.indexrelid
    JOIN pg_class source_table ON source_table.oid = index_row.indrelid
    WHERE source_table.relnamespace = 'public'::regnamespace
  `)
  for (const required of REQUIRED_INDEXES) {
    const actual = indexRows.rows.find(row => row.indexname === required.name)
    const actualExpressions = actual?.expressions.map(normalizedIndexExpression)
    const requiredExpressions = required.expressions.map(normalizedIndexExpression)
    if (
      !actual
      || actual.table_name !== required.table
      || actual.unique !== required.unique
      || JSON.stringify(actualExpressions) !== JSON.stringify(requiredExpressions)
    ) {
      throw new Error(`PostgreSQL index ${required.name} is missing or invalid`)
    }
  }

  const emailRows = await database.query<{ id: string; address: unknown }>(`
    SELECT id, address
    FROM email
    ORDER BY id
  `)
  const normalizedAddresses = new Set<string>()
  for (const row of emailRows.rows) {
    const normalizedAddress = normalizeMailboxAddress(row.address)
    if (!normalizedAddress) {
      throw new Error(`PostgreSQL email ${row.id} has an unsupported mailbox address`)
    }
    if (normalizedAddresses.has(normalizedAddress)) {
      throw new Error(`PostgreSQL database contains duplicate mailbox address ${normalizedAddress}`)
    }
    normalizedAddresses.add(normalizedAddress)
  }

  const foreignKeyRows = await database.query<{
    columns: string[]
    conname: string
    convalidated: boolean
    on_delete: string
    referenced_columns: string[]
    referenced_table: string
    table_name: string
  }>(`
    SELECT
      constraint_row.conname,
      constraint_row.convalidated,
      constraint_row.confdeltype::text AS on_delete,
      source_table.relname AS table_name,
      referenced_table.relname AS referenced_table,
      ARRAY(
        SELECT source_column.attname::text
        FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, position)
        JOIN pg_attribute source_column
          ON source_column.attrelid = constraint_row.conrelid
         AND source_column.attnum = key_column.attnum
        ORDER BY key_column.position
      ) AS columns,
      ARRAY(
        SELECT referenced_column.attname::text
        FROM unnest(constraint_row.confkey) WITH ORDINALITY AS key_column(attnum, position)
        JOIN pg_attribute referenced_column
          ON referenced_column.attrelid = constraint_row.confrelid
         AND referenced_column.attnum = key_column.attnum
        ORDER BY key_column.position
      ) AS referenced_columns
    FROM pg_constraint constraint_row
    JOIN pg_class source_table ON source_table.oid = constraint_row.conrelid
    JOIN pg_class referenced_table ON referenced_table.oid = constraint_row.confrelid
    WHERE constraint_row.contype = 'f'
      AND constraint_row.connamespace = 'public'::regnamespace
  `)
  for (const required of REQUIRED_FOREIGN_KEYS) {
    const actual = foreignKeyRows.rows.find(row => row.conname === required.name)
    if (
      !actual
      || !actual.convalidated
      || actual.table_name !== required.table
      || actual.referenced_table !== required.referencedTable
      || actual.on_delete !== required.onDelete
      || JSON.stringify(actual.columns) !== JSON.stringify(required.columns)
      || JSON.stringify(actual.referenced_columns) !== JSON.stringify(required.referencedColumns)
    ) {
      throw new Error(`PostgreSQL foreign key ${required.name} is missing or invalid`)
    }
  }

  const migrationRows = await database.query<{ count: string }>(`
    SELECT COUNT(*)::text AS count
    FROM drizzle.__drizzle_migrations
  `)
  const emperorUsers = await database.query<{ count: string }>(`
    SELECT COUNT(DISTINCT user_role.user_id)::text AS count
    FROM user_role
    INNER JOIN "role" ON "role".id = user_role.role_id
    WHERE "role".name = 'emperor'
  `)
  if (Number(emperorUsers.rows[0].count) > 1) {
    throw new Error("PostgreSQL database contains multiple emperor users")
  }
  const rowCounts: Record<string, number> = {}
  for (const table of POSTGRES_TABLES) {
    const result = await database.query<QueryResultRow>(
      `SELECT COUNT(*)::text AS count FROM "${table}"`,
    )
    rowCounts[table] = Number(result.rows[0].count)
  }

  return {
    database: metadata.rows[0].database_name,
    serverVersion: metadata.rows[0].server_version,
    migrationCount: Number(migrationRows.rows[0].count),
    tables: POSTGRES_TABLES.length,
    indexes: REQUIRED_INDEXES.length,
    keyConstraints: REQUIRED_KEY_CONSTRAINTS.length,
    foreignKeys: REQUIRED_FOREIGN_KEYS.length,
    securityInvariants: {
      asciiMailboxAddresses: true,
      caseInsensitiveEmailUnique: true,
      emperorUsers: Number(emperorUsers.rows[0].count),
    },
    rowCounts,
  }
}
