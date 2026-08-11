import { getBoundDriver } from "./database-dialect"
import * as postgresSchema from "./local-schema.postgres"
import * as sqliteSchema from "./local-schema.sqlite"

const activeSchema = getBoundDriver() === "postgres"
  ? postgresSchema as unknown as typeof sqliteSchema
  : sqliteSchema

export const siteConfig = activeSchema.siteConfig
