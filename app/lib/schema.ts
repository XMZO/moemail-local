import { getBoundDriver } from "./database-dialect"
import * as postgresSchema from "./schema.postgres"
import * as sqliteSchema from "./schema.sqlite"

const activeSchema = getBoundDriver() === "postgres"
  ? postgresSchema as unknown as typeof sqliteSchema
  : sqliteSchema

export const users = activeSchema.users
export const accounts = activeSchema.accounts
export const emails = activeSchema.emails
export const messages = activeSchema.messages
export const webhooks = activeSchema.webhooks
export const roles = activeSchema.roles
export const userRoles = activeSchema.userRoles
export const apiKeys = activeSchema.apiKeys
export const emailShares = activeSchema.emailShares
export const messageShares = activeSchema.messageShares

export const apiKeysRelations = activeSchema.apiKeysRelations
export const userRolesRelations = activeSchema.userRolesRelations
export const usersRelations = activeSchema.usersRelations
export const rolesRelations = activeSchema.rolesRelations
export const emailSharesRelations = activeSchema.emailSharesRelations
export const messageSharesRelations = activeSchema.messageSharesRelations
