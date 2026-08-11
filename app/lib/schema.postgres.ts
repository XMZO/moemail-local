import { relations, sql } from "drizzle-orm"
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import type { AdapterAccountType } from "next-auth/adapters"

const dateColumn = (name: string) => timestamp(name, {
  mode: "date",
  withTimezone: true,
})

export const users = pgTable("user", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: dateColumn("emailVerified"),
  image: text("image"),
  username: text("username").unique(),
  password: text("password"),
})

export const accounts = pgTable(
  "account",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => [
    primaryKey({ columns: [account.provider, account.providerAccountId] }),
    index("account_user_id_idx").on(account.userId),
  ],
)

export const emails = pgTable("email", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  address: text("address").notNull().unique(),
  userId: text("userId").references(() => users.id, { onDelete: "cascade" }),
  createdAt: dateColumn("created_at").notNull().$defaultFn(() => new Date()),
  expiresAt: dateColumn("expires_at").notNull(),
}, (table) => [
  index("email_expires_at_idx").on(table.expiresAt),
  index("email_user_id_idx").on(table.userId),
  uniqueIndex("email_address_lower_idx").on(sql`LOWER(${table.address})`),
])

export const messages = pgTable("message", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  emailId: text("emailId")
    .notNull()
    .references(() => emails.id, { onDelete: "cascade" }),
  fromAddress: text("from_address"),
  toAddress: text("to_address"),
  subject: text("subject").notNull(),
  content: text("content").notNull(),
  html: text("html"),
  type: text("type"),
  receivedAt: dateColumn("received_at").notNull().$defaultFn(() => new Date()),
  sentAt: dateColumn("sent_at").notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("message_email_id_idx").on(table.emailId),
  index("message_email_id_received_at_type_idx").on(table.emailId, table.receivedAt, table.type),
])

export const webhooks = pgTable("webhook", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: dateColumn("created_at").notNull().$defaultFn(() => new Date()),
  updatedAt: dateColumn("updated_at").notNull().$defaultFn(() => new Date()),
}, (table) => [index("webhook_user_id_idx").on(table.userId)])

export const roles = pgTable("role", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: dateColumn("created_at").$defaultFn(() => new Date()),
  updatedAt: dateColumn("updated_at").$defaultFn(() => new Date()),
})

export const userRoles = pgTable("user_role", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  roleId: text("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  createdAt: dateColumn("created_at").$defaultFn(() => new Date()),
}, (table) => [
  primaryKey({ columns: [table.userId, table.roleId] }),
  index("user_role_user_id_idx").on(table.userId),
])

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  key: text("key").notNull().unique(),
  createdAt: dateColumn("created_at").$defaultFn(() => new Date()),
  expiresAt: dateColumn("expires_at"),
  enabled: boolean("enabled").notNull().default(true),
}, (table) => [
  uniqueIndex("name_user_id_unique").on(table.name, table.userId),
  index("api_keys_user_id_idx").on(table.userId),
])

export const emailShares = pgTable("email_share", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  emailId: text("email_id")
    .notNull()
    .references(() => emails.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  createdAt: dateColumn("created_at").notNull().$defaultFn(() => new Date()),
  expiresAt: dateColumn("expires_at"),
}, (table) => [
  index("email_share_email_id_idx").on(table.emailId),
  index("email_share_token_idx").on(table.token),
])

export const messageShares = pgTable("message_share", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  messageId: text("message_id")
    .notNull()
    .references(() => messages.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  createdAt: dateColumn("created_at").notNull().$defaultFn(() => new Date()),
  expiresAt: dateColumn("expires_at"),
}, (table) => [
  index("message_share_message_id_idx").on(table.messageId),
  index("message_share_token_idx").on(table.token),
])

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, { fields: [apiKeys.userId], references: [users.id] }),
}))

export const userRolesRelations = relations(userRoles, ({ one }) => ({
  user: one(users, { fields: [userRoles.userId], references: [users.id] }),
  role: one(roles, { fields: [userRoles.roleId], references: [roles.id] }),
}))

export const usersRelations = relations(users, ({ many }) => ({
  userRoles: many(userRoles),
  apiKeys: many(apiKeys),
}))

export const rolesRelations = relations(roles, ({ many }) => ({
  userRoles: many(userRoles),
}))

export const emailSharesRelations = relations(emailShares, ({ one }) => ({
  email: one(emails, { fields: [emailShares.emailId], references: [emails.id] }),
}))

export const messageSharesRelations = relations(messageShares, ({ one }) => ({
  message: one(messages, { fields: [messageShares.messageId], references: [messages.id] }),
}))
