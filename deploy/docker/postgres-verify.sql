\set ON_ERROR_STOP on

DO $verify$
DECLARE
  missing_items text;
  emperor_count bigint;
BEGIN
  SELECT string_agg(required.name, ', ' ORDER BY required.name)
  INTO missing_items
  FROM (VALUES
    ('account'), ('api_keys'), ('email'), ('email_share'), ('message'),
    ('message_share'), ('role'), ('site_config'), ('user'), ('user_role'),
    ('webhook')
  ) AS required(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.tables actual
    WHERE actual.table_schema = 'public'
      AND actual.table_type = 'BASE TABLE'
      AND actual.table_name = required.name
  );
  IF missing_items IS NOT NULL THEN
    RAISE EXCEPTION 'PostgreSQL database is missing tables: %', missing_items;
  END IF;

  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION 'PostgreSQL database is missing drizzle.__drizzle_migrations';
  END IF;

  SELECT string_agg(required.column_name, ', ' ORDER BY required.column_name)
  INTO missing_items
  FROM (VALUES ('id'), ('hash'), ('created_at')) AS required(column_name)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns actual
    WHERE actual.table_schema = 'drizzle'
      AND actual.table_name = '__drizzle_migrations'
      AND actual.column_name = required.column_name
  );
  IF missing_items IS NOT NULL THEN
    RAISE EXCEPTION 'PostgreSQL table drizzle.__drizzle_migrations is missing columns: %', missing_items;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'drizzle.__drizzle_migrations'::regclass
      AND constraint_row.contype = 'p'
      AND ARRAY(
        SELECT source_column.attname
        FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, position)
        JOIN pg_attribute source_column
          ON source_column.attrelid = constraint_row.conrelid
         AND source_column.attnum = key_column.attnum
        ORDER BY key_column.position
      ) = ARRAY['id']::name[]
  ) THEN
    RAISE EXCEPTION 'PostgreSQL table drizzle.__drizzle_migrations primary key is invalid';
  END IF;

  SELECT string_agg(required.table_name || '.' || required.column_name, ', '
                    ORDER BY required.table_name, required.column_name)
  INTO missing_items
  FROM (VALUES
    ('account', 'userId'), ('account', 'type'), ('account', 'provider'),
    ('account', 'providerAccountId'), ('account', 'refresh_token'),
    ('account', 'access_token'), ('account', 'expires_at'),
    ('account', 'token_type'), ('account', 'scope'), ('account', 'id_token'),
    ('account', 'session_state'),
    ('api_keys', 'id'), ('api_keys', 'user_id'), ('api_keys', 'name'),
    ('api_keys', 'key'), ('api_keys', 'created_at'), ('api_keys', 'expires_at'),
    ('api_keys', 'enabled'),
    ('email', 'id'), ('email', 'address'), ('email', 'userId'),
    ('email', 'created_at'), ('email', 'expires_at'),
    ('email_share', 'id'), ('email_share', 'email_id'), ('email_share', 'token'),
    ('email_share', 'created_at'), ('email_share', 'expires_at'),
    ('message', 'id'), ('message', 'emailId'), ('message', 'from_address'),
    ('message', 'to_address'), ('message', 'subject'), ('message', 'content'),
    ('message', 'html'), ('message', 'type'), ('message', 'received_at'),
    ('message', 'sent_at'),
    ('message_share', 'id'), ('message_share', 'message_id'),
    ('message_share', 'token'), ('message_share', 'created_at'),
    ('message_share', 'expires_at'),
    ('role', 'id'), ('role', 'name'), ('role', 'description'),
    ('role', 'created_at'), ('role', 'updated_at'),
    ('site_config', 'key'), ('site_config', 'value'), ('site_config', 'updated_at'),
    ('user', 'id'), ('user', 'name'), ('user', 'email'),
    ('user', 'emailVerified'), ('user', 'image'), ('user', 'username'),
    ('user', 'password'),
    ('user_role', 'user_id'), ('user_role', 'role_id'), ('user_role', 'created_at'),
    ('webhook', 'id'), ('webhook', 'user_id'), ('webhook', 'url'),
    ('webhook', 'enabled'), ('webhook', 'created_at'), ('webhook', 'updated_at')
  ) AS required(table_name, column_name)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns actual
    WHERE actual.table_schema = 'public'
      AND actual.table_name = required.table_name
      AND actual.column_name = required.column_name
  );
  IF missing_items IS NOT NULL THEN
    RAISE EXCEPTION 'PostgreSQL database is missing columns: %', missing_items;
  END IF;

  SELECT string_agg(required.name, ', ' ORDER BY required.name)
  INTO missing_items
  FROM (VALUES
    ('account_provider_providerAccountId_pk', 'account', 'p', ARRAY['provider', 'providerAccountId']::text[]),
    ('api_keys_pkey', 'api_keys', 'p', ARRAY['id']::text[]),
    ('email_share_pkey', 'email_share', 'p', ARRAY['id']::text[]),
    ('email_pkey', 'email', 'p', ARRAY['id']::text[]),
    ('message_share_pkey', 'message_share', 'p', ARRAY['id']::text[]),
    ('message_pkey', 'message', 'p', ARRAY['id']::text[]),
    ('role_pkey', 'role', 'p', ARRAY['id']::text[]),
    ('site_config_pkey', 'site_config', 'p', ARRAY['key']::text[]),
    ('user_role_user_id_role_id_pk', 'user_role', 'p', ARRAY['user_id', 'role_id']::text[]),
    ('user_pkey', 'user', 'p', ARRAY['id']::text[]),
    ('webhook_pkey', 'webhook', 'p', ARRAY['id']::text[]),
    ('api_keys_key_unique', 'api_keys', 'u', ARRAY['key']::text[]),
    ('email_share_token_unique', 'email_share', 'u', ARRAY['token']::text[]),
    ('email_address_unique', 'email', 'u', ARRAY['address']::text[]),
    ('message_share_token_unique', 'message_share', 'u', ARRAY['token']::text[]),
    ('user_email_unique', 'user', 'u', ARRAY['email']::text[]),
    ('user_username_unique', 'user', 'u', ARRAY['username']::text[])
  ) AS required(name, table_name, constraint_type, columns)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_constraint actual
    JOIN pg_class source_table ON source_table.oid = actual.conrelid
    WHERE actual.connamespace = 'public'::regnamespace
      AND actual.conname = required.name
      AND source_table.relname = required.table_name
      AND actual.contype::text = required.constraint_type
      AND ARRAY(
        SELECT source_column.attname::text
        FROM unnest(actual.conkey) WITH ORDINALITY AS key_column(attnum, position)
        JOIN pg_attribute source_column
          ON source_column.attrelid = actual.conrelid
         AND source_column.attnum = key_column.attnum
        ORDER BY key_column.position
      ) = required.columns
  );
  IF missing_items IS NOT NULL THEN
    RAISE EXCEPTION 'PostgreSQL database has missing or invalid key constraints: %', missing_items;
  END IF;

  SELECT string_agg(required.name, ', ' ORDER BY required.name)
  INTO missing_items
  FROM (VALUES
    ('account_user_id_idx', 'account', false, ARRAY['userid']::text[]),
    ('api_keys_user_id_idx', 'api_keys', false, ARRAY['user_id']::text[]),
    ('email_address_lower_idx', 'email', true, ARRAY['lower(address)']::text[]),
    ('email_expires_at_idx', 'email', false, ARRAY['expires_at']::text[]),
    ('email_share_email_id_idx', 'email_share', false, ARRAY['email_id']::text[]),
    ('email_share_token_idx', 'email_share', false, ARRAY['token']::text[]),
    ('email_user_id_idx', 'email', false, ARRAY['userid']::text[]),
    ('message_email_id_idx', 'message', false, ARRAY['emailid']::text[]),
    ('message_email_id_received_at_type_idx', 'message', false, ARRAY['emailid', 'received_at', 'type']::text[]),
    ('message_share_message_id_idx', 'message_share', false, ARRAY['message_id']::text[]),
    ('message_share_token_idx', 'message_share', false, ARRAY['token']::text[]),
    ('name_user_id_unique', 'api_keys', true, ARRAY['name', 'user_id']::text[]),
    ('user_role_user_id_idx', 'user_role', false, ARRAY['user_id']::text[]),
    ('webhook_user_id_idx', 'webhook', false, ARRAY['user_id']::text[])
  ) AS required(name, table_name, is_unique, expressions)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_index actual
    JOIN pg_class index_table ON index_table.oid = actual.indexrelid
    JOIN pg_class source_table ON source_table.oid = actual.indrelid
    WHERE source_table.relnamespace = 'public'::regnamespace
      AND index_table.relname = required.name
      AND source_table.relname = required.table_name
      AND actual.indisunique = required.is_unique
      AND actual.indisvalid
      AND actual.indisready
      AND actual.indpred IS NULL
      AND ARRAY(
        SELECT lower(regexp_replace(COALESCE(
          source_column.attname,
          pg_get_indexdef(actual.indexrelid, key_column.position::integer, true)
        ), '["[:space:]]', '', 'g'))
        FROM unnest(actual.indkey) WITH ORDINALITY AS key_column(attnum, position)
        LEFT JOIN pg_attribute source_column
          ON source_column.attrelid = actual.indrelid
         AND source_column.attnum = key_column.attnum
        ORDER BY key_column.position
      ) = required.expressions
  );
  IF missing_items IS NOT NULL THEN
    RAISE EXCEPTION 'PostgreSQL database has missing or invalid indexes: %', missing_items;
  END IF;

  SELECT string_agg(required.name, ', ' ORDER BY required.name)
  INTO missing_items
  FROM (VALUES
    ('account_userId_user_id_fk', 'account', ARRAY['userId']::text[], 'user', ARRAY['id']::text[], 'c'),
    ('api_keys_user_id_user_id_fk', 'api_keys', ARRAY['user_id']::text[], 'user', ARRAY['id']::text[], 'a'),
    ('email_share_email_id_email_id_fk', 'email_share', ARRAY['email_id']::text[], 'email', ARRAY['id']::text[], 'c'),
    ('email_userId_user_id_fk', 'email', ARRAY['userId']::text[], 'user', ARRAY['id']::text[], 'c'),
    ('message_share_message_id_message_id_fk', 'message_share', ARRAY['message_id']::text[], 'message', ARRAY['id']::text[], 'c'),
    ('message_emailId_email_id_fk', 'message', ARRAY['emailId']::text[], 'email', ARRAY['id']::text[], 'c'),
    ('user_role_role_id_role_id_fk', 'user_role', ARRAY['role_id']::text[], 'role', ARRAY['id']::text[], 'c'),
    ('user_role_user_id_user_id_fk', 'user_role', ARRAY['user_id']::text[], 'user', ARRAY['id']::text[], 'c'),
    ('webhook_user_id_user_id_fk', 'webhook', ARRAY['user_id']::text[], 'user', ARRAY['id']::text[], 'c')
  ) AS required(name, table_name, columns, referenced_table, referenced_columns, delete_action)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_constraint actual
    JOIN pg_class source_table ON source_table.oid = actual.conrelid
    JOIN pg_class referenced_table ON referenced_table.oid = actual.confrelid
    WHERE actual.connamespace = 'public'::regnamespace
      AND actual.contype = 'f'
      AND actual.conname = required.name
      AND actual.convalidated
      AND source_table.relname = required.table_name
      AND referenced_table.relname = required.referenced_table
      AND actual.confdeltype::text = required.delete_action
      AND ARRAY(
        SELECT source_column.attname::text
        FROM unnest(actual.conkey) WITH ORDINALITY AS key_column(attnum, position)
        JOIN pg_attribute source_column
          ON source_column.attrelid = actual.conrelid
         AND source_column.attnum = key_column.attnum
        ORDER BY key_column.position
      ) = required.columns
      AND ARRAY(
        SELECT referenced_column.attname::text
        FROM unnest(actual.confkey) WITH ORDINALITY AS key_column(attnum, position)
        JOIN pg_attribute referenced_column
          ON referenced_column.attrelid = actual.confrelid
         AND referenced_column.attnum = key_column.attnum
        ORDER BY key_column.position
      ) = required.referenced_columns
  );
  IF missing_items IS NOT NULL THEN
    RAISE EXCEPTION 'PostgreSQL database has missing or invalid foreign keys: %', missing_items;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public."email"
    WHERE octet_length(address) <> char_length(address)
  ) THEN
    RAISE EXCEPTION 'PostgreSQL database contains non-ASCII mailbox addresses';
  END IF;
  IF EXISTS (
    SELECT lower(address) FROM public."email" GROUP BY lower(address) HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'PostgreSQL database contains case-insensitive duplicate mailbox addresses';
  END IF;

  SELECT count(DISTINCT user_role.user_id)
  INTO emperor_count
  FROM public.user_role
  INNER JOIN public."role" ON "role".id = user_role.role_id
  WHERE "role".name = 'emperor';
  IF emperor_count <> 1 THEN
    RAISE EXCEPTION 'PostgreSQL database must contain exactly one emperor user (found %)', emperor_count;
  END IF;
END
$verify$;
