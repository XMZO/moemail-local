import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { ConfigKey } from "../app/lib/config-store"
import { requireValidatedRuntimeConfig } from "./ops/validated-runtime"

const runtimeConfig = await requireValidatedRuntimeConfig("site configuration import")
const {
  CONFIG_KEYS,
  getConfigValues,
  setConfigValues,
} = await import("../app/lib/config-store")
const { closeDatabase } = await import("../app/lib/db")

const argumentsList = process.argv.slice(2)
const force = argumentsList.includes("--force")
const databaseDriver = runtimeConfig.database.driver
const unknownOptions = argumentsList.filter(
  argument => argument.startsWith("--") && argument !== "--force",
)
const sourceArguments = argumentsList.filter(argument => !argument.startsWith("--"))

if (unknownOptions.length > 0) {
  throw new Error(`Unknown options: ${unknownOptions.join(", ")}`)
}
if (sourceArguments.length !== 1) {
  throw new Error("Usage: pnpm db:import-config <config.json> [--force]")
}

const allowedKeys = new Set<ConfigKey>(Object.values(CONFIG_KEYS))
const sourcePath = resolve(process.cwd(), sourceArguments[0])
const parsed = JSON.parse(readFileSync(sourcePath, "utf8")) as unknown

function parseEntries(value: unknown): Array<[ConfigKey, string]> {
  const entries = Array.isArray(value)
    ? value.map(item => {
        if (!item || typeof item !== "object") {
          throw new Error("Config array entries must be objects")
        }
        const { key, value: itemValue } = item as { key?: unknown; value?: unknown }
        return [key, itemValue]
      })
    : value && typeof value === "object"
      ? Object.entries(value)
      : null

  if (!entries) {
    throw new Error("Config JSON must be an object or an array of { key, value }")
  }

  return entries.map(([key, itemValue]) => {
    if (typeof key !== "string" || !allowedKeys.has(key as ConfigKey)) {
      throw new Error(`Unknown config key: ${String(key)}`)
    }
    if (typeof itemValue !== "string") {
      throw new Error(`Config value for ${key} must be a string`)
    }
    return [key as ConfigKey, itemValue]
  })
}

try {
  const entries = parseEntries(parsed)
  const duplicateKeys = entries
    .map(([key]) => key)
    .filter((key, index, keys) => keys.indexOf(key) !== index)
  if (duplicateKeys.length > 0) {
    throw new Error(`Duplicate config keys: ${[...new Set(duplicateKeys)].join(", ")}`)
  }

  const existing = await getConfigValues(entries.map(([key]) => key))
  const conflicts = entries
    .map(([key]) => key)
    .filter(key => existing[key] !== null)
  if (conflicts.length > 0 && !force) {
    throw new Error(
      `Target already contains config keys: ${conflicts.join(", ")}; rerun with --force to overwrite`,
    )
  }

  await setConfigValues(Object.fromEntries(entries))
  console.log(JSON.stringify({
    event: "config.import.ok",
    databaseDriver,
    sourcePath,
    imported: entries.length,
    overwritten: conflicts.length,
  }))
} finally {
  await closeDatabase()
}
