import type { Locale } from "./config"

export const MESSAGE_MODULES = [
  "common",
  "home",
  "auth",
  "metadata",
  "emails",
  "profile",
  "admin",
  "runtime",
  "domains",
  "setup",
  "api",
] as const

export type MessageModule = typeof MESSAGE_MODULES[number]
export type AppMessages = Record<MessageModule, Record<string, unknown>>

export async function loadMessages(locale: Locale): Promise<AppMessages> {
  const entries = await Promise.all(MESSAGE_MODULES.map(async moduleName => [
    moduleName,
    (await import(`./messages/${locale}/${moduleName}.json`)).default as Record<string, unknown>,
  ] as const))
  return Object.fromEntries(entries) as AppMessages
}

export function emptyMessages(): AppMessages {
  return Object.fromEntries(MESSAGE_MODULES.map(moduleName => [moduleName, {}])) as AppMessages
}
