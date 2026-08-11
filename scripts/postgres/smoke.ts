import { DrizzleAdapter } from "@auth/drizzle-adapter"
import { and, eq, inArray } from "drizzle-orm"
import type { NodePgDatabase } from "drizzle-orm/node-postgres"
import {
  closeDatabase,
  createDb,
  getDatabaseDriver,
} from "../../app/lib/db"
import * as localSchema from "../../app/lib/local-schema.postgres"
import * as schema from "../../app/lib/schema.postgres"
import { requireValidatedRuntimeConfig } from "../ops/validated-runtime"

class ExpectedRollback extends Error {}

await requireValidatedRuntimeConfig("PostgreSQL smoke test")
const {
  CONFIG_KEYS,
  getConfigValues,
  setConfigValues,
} = await import("../../app/lib/config-store")

if (!process.argv.includes("--allow-write")) {
  throw new Error("Pass --allow-write to run the PostgreSQL write smoke test")
}
if (getDatabaseDriver() !== "postgres") {
  throw new Error("Set database.driver to postgres in data/config.yaml before running the PostgreSQL smoke test")
}

const db = createDb() as unknown as NodePgDatabase<
  typeof schema & typeof localSchema
>
const suffix = crypto.randomUUID()
const roleId = `test-role-${suffix}`
const emailId = `test-email-${suffix}`
const messageId = `test-message-${suffix}`
const apiKeyId = `test-api-key-${suffix}`
const now = new Date()
let assertions = 0
let createdUserId: string | null = null

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
  assertions += 1
}

try {
  try {
    await db.transaction(async transaction => {
      const adapter = DrizzleAdapter(transaction, {
        usersTable: schema.users,
        accountsTable: schema.accounts,
      })
      const user = await adapter.createUser!({
        id: `test-user-${suffix}`,
        name: "PostgreSQL smoke",
        email: `${suffix}@example.test`,
        emailVerified: null,
        image: null,
      })
      assert(typeof user.id === "string" && user.id.length > 0, "Auth adapter createUser failed")
      createdUserId = user.id

      await adapter.linkAccount!({
        userId: createdUserId,
        type: "oauth",
        provider: "smoke",
        providerAccountId: suffix,
        access_token: "test-token",
      })
      const adapterUser = await adapter.getUserByAccount!({
        provider: "smoke",
        providerAccountId: suffix,
      })
      assert(adapterUser?.id === createdUserId, "Auth adapter account relation lookup failed")

      await transaction.insert(schema.roles).values({
        id: roleId,
        name: `role-${suffix}`,
      })
      await transaction.insert(schema.userRoles).values({ userId: createdUserId, roleId })
      await transaction.insert(schema.apiKeys).values({
        id: apiKeyId,
        userId: createdUserId,
        name: `key-${suffix}`,
        key: `secret-${suffix}`,
        expiresAt: new Date(now.getTime() + 60_000),
      })

      const relationalUser = await transaction.query.users.findFirst({
        where: eq(schema.users.id, createdUserId),
        with: {
          apiKeys: true,
          userRoles: { with: { role: true } },
        },
      })
      assert(relationalUser?.apiKeys.length === 1, "User to API key relation failed")
      assert(
        relationalUser.userRoles[0]?.role.name === `role-${suffix}`,
        "Nested user role relation failed",
      )

      const [email] = await transaction.insert(schema.emails).values({
        id: emailId,
        address: `${suffix}@mail.example.test`,
        userId: createdUserId,
        expiresAt: new Date(now.getTime() + 60_000),
      }).returning({ id: schema.emails.id })
      assert(email.id === emailId, "PostgreSQL returning() failed")

      const insertionResults = await Promise.all(
        Array.from({ length: 20 }, () => transaction.insert(schema.messages).values({
          id: messageId,
          emailId,
          fromAddress: "sender@example.test",
          toAddress: `${suffix}@mail.example.test`,
          subject: "Idempotency smoke",
          content: "same RFC822-derived body",
          type: "received",
        }).onConflictDoNothing({ target: schema.messages.id }).returning({
          id: schema.messages.id,
        })),
      )
      assert(
        insertionResults.flat().length === 1,
        "Twenty concurrent idempotent inserts did not create exactly one message",
      )

      await transaction.insert(schema.messageShares).values({
        id: `test-message-share-${suffix}`,
        messageId,
        token: `message-token-${suffix}`,
      })
      await transaction.insert(schema.emailShares).values({
        id: `test-email-share-${suffix}`,
        emailId,
        token: `email-token-${suffix}`,
      })
      await transaction.delete(schema.emails).where(eq(schema.emails.id, emailId))

      const [remainingMessage, remainingEmailShare, remainingMessageShare] = await Promise.all([
        transaction.query.messages.findFirst({ where: eq(schema.messages.id, messageId) }),
        transaction.query.emailShares.findFirst({
          where: eq(schema.emailShares.emailId, emailId),
        }),
        transaction.query.messageShares.findFirst({
          where: eq(schema.messageShares.messageId, messageId),
        }),
      ])
      assert(!remainingMessage, "Email deletion did not cascade to messages")
      assert(!remainingEmailShare, "Email deletion did not cascade to email shares")
      assert(!remainingMessageShare, "Message deletion did not cascade to message shares")

      const key = await transaction.query.apiKeys.findFirst({
        where: and(
          eq(schema.apiKeys.id, apiKeyId),
          eq(schema.apiKeys.enabled, true),
        ),
        with: { user: true },
      })
      assert(key?.user.id === createdUserId, "API key to user relation failed")

      throw new ExpectedRollback()
    })
    throw new Error("Smoke transaction unexpectedly committed")
  } catch (error) {
    if (!(error instanceof ExpectedRollback)) throw error
  }

  assert(createdUserId, "Smoke test did not create a user")
  const rolledBackUser = await db.query.users.findFirst({
    where: eq(schema.users.id, createdUserId),
  })
  assert(!rolledBackUser, "Smoke transaction rollback did not remove test data")

  const configKeys = [CONFIG_KEYS.DEFAULT_ROLE, CONFIG_KEYS.ADMIN_CONTACT] as const
  const previousConfig = await getConfigValues(configKeys)
  try {
    await setConfigValues({
      [CONFIG_KEYS.DEFAULT_ROLE]: "civilian",
      [CONFIG_KEYS.ADMIN_CONTACT]: `${suffix}@example.test`,
    })
    const insertedConfig = await getConfigValues(configKeys)
    assert(insertedConfig.DEFAULT_ROLE === "civilian", "ConfigStore insert failed")
    assert(
      insertedConfig.ADMIN_CONTACT === `${suffix}@example.test`,
      "ConfigStore multi-row upsert failed",
    )
    await setConfigValues({ [CONFIG_KEYS.DEFAULT_ROLE]: "knight" })
    const updatedConfig = await getConfigValues(configKeys)
    assert(updatedConfig.DEFAULT_ROLE === "knight", "ConfigStore conflict update failed")
  } finally {
    const absentKeys = configKeys.filter(key => previousConfig[key] === null)
    if (absentKeys.length > 0) {
      await db.delete(localSchema.siteConfig).where(
        inArray(localSchema.siteConfig.key, absentKeys),
      )
    }
    const valuesToRestore = Object.fromEntries(
      configKeys
        .filter(key => previousConfig[key] !== null)
        .map(key => [key, previousConfig[key]!]),
    )
    await setConfigValues(valuesToRestore)
  }

  console.log(JSON.stringify({
    event: "postgres.smoke.ok",
    assertions,
    concurrentIdempotencyAttempts: 20,
  }))
} finally {
  await closeDatabase()
}
