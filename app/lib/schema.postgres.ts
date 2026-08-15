import { relations, sql } from "drizzle-orm"
import {
  boolean,
  check,
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
  bannedAt: dateColumn("banned_at"),
}, (table) => [
  index("user_banned_at_idx").on(table.bannedAt),
])

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

export const sendQuotaEvents = pgTable("send_quota_event", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .references(() => users.id, { onDelete: "set null" }),
  quotaSubject: text("quota_subject").notNull(),
  policyRole: text("policy_role").$type<"emperor" | "duke" | "knight" | "civilian">().notNull(),
  direction: text("direction").$type<"send" | "receive">().notNull().default("send"),
  senderDomain: text("sender_domain").notNull(),
  mailboxAddress: text("mailbox_address").notNull().default(""),
  globalRuleId: text("global_rule_id"),
  scopedRuleId: text("scoped_rule_id"),
  status: text("status").notNull().default("reserved"),
  createdAt: dateColumn("created_at").notNull().$defaultFn(() => new Date()),
  reservationExpiresAt: dateColumn("reservation_expires_at").notNull(),
  completedAt: dateColumn("completed_at"),
}, (table) => [
  index("send_quota_event_subject_created_idx").on(table.quotaSubject, table.createdAt),
  index("send_quota_event_subject_domain_created_idx").on(table.quotaSubject, table.senderDomain, table.createdAt),
  index("send_quota_event_subject_direction_created_idx").on(table.quotaSubject, table.direction, table.createdAt),
  index("send_quota_event_subject_direction_domain_created_idx").on(table.quotaSubject, table.direction, table.senderDomain, table.createdAt),
  index("send_quota_event_user_direction_mailbox_created_idx").on(table.userId, table.direction, table.mailboxAddress, table.createdAt),
  index("send_quota_event_user_created_idx").on(table.userId, table.createdAt),
  index("send_quota_event_role_created_idx").on(table.policyRole, table.createdAt),
  index("send_quota_event_global_rule_created_idx").on(table.globalRuleId, table.createdAt),
  index("send_quota_event_scoped_rule_created_idx").on(table.scopedRuleId, table.createdAt),
  index("send_quota_event_scoped_rule_user_created_idx").on(table.scopedRuleId, table.userId, table.createdAt),
  check("send_quota_event_status_check", sql`${table.status} IN ('reserved', 'sent')`),
  check("send_quota_event_direction_check", sql`${table.direction} IN ('send', 'receive')`),
  check("send_quota_event_role_check", sql`${table.policyRole} IN ('emperor', 'duke', 'knight', 'civilian')`),
])

export const mailboxNameBlocks = pgTable("mailbox_name_block", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  scopeKey: text("scope_key").notNull(),
  localPart: text("local_part").notNull(),
  domain: text("domain").notNull(),
  createdAt: dateColumn("created_at").notNull().$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex("mailbox_name_block_scope_unique").on(table.scopeKey, table.localPart, table.domain),
  index("mailbox_name_block_lookup_idx").on(table.localPart, table.domain, table.scopeKey),
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
  sendQuotaEvents: many(sendQuotaEvents),
  mailboxNameBlocks: many(mailboxNameBlocks),
}))

export const sendQuotaEventsRelations = relations(sendQuotaEvents, ({ one }) => ({
  user: one(users, { fields: [sendQuotaEvents.userId], references: [users.id] }),
}))

export const mailboxNameBlocksRelations = relations(mailboxNameBlocks, ({ one }) => ({
  user: one(users, { fields: [mailboxNameBlocks.userId], references: [users.id] }),
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
