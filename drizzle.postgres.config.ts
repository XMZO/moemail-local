import type { Config } from "drizzle-kit"
import { loadTrustedLastKnownGoodConfig } from "./scripts/ops/trusted-config"

const databaseUrl = loadTrustedLastKnownGoodConfig().database.postgres.url
if (!databaseUrl) throw new Error("database.postgres.url is required")

export default {
  dialect: "postgresql",
  schema: [
    "./app/lib/schema.postgres.ts",
    "./app/lib/local-schema.postgres.ts",
  ],
  out: "./drizzle-postgres",
  dbCredentials: {
    url: databaseUrl,
  },
} satisfies Config
