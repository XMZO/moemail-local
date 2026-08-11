import { resolve } from "node:path"
import type { Config } from "drizzle-kit"
import { loadTrustedLastKnownGoodConfig } from "./scripts/ops/trusted-config"

const configuredPath = loadTrustedLastKnownGoodConfig().database.sqlite.path

export default {
  dialect: "sqlite",
  schema: ["./app/lib/schema.sqlite.ts", "./app/lib/local-schema.sqlite.ts"],
  out: "./drizzle-local",
  dbCredentials: {
    url: configuredPath === ":memory:"
      ? configuredPath
      : resolve(process.cwd(), configuredPath),
  },
} satisfies Config
