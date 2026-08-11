import type { Config } from "drizzle-kit";

export default {
  dialect: "sqlite",
  schema: "./app/lib/schema.sqlite.ts",
} satisfies Config;
