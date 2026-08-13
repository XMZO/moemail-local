import assert from "node:assert/strict"
import { createDefaultConfig } from "../../app/lib/config/schema"
import { runtimeConfigFields } from "../../app/components/profile/runtime-config-fields"

function leafPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([key, child]) => (
    leafPaths(child, prefix ? `${prefix}.${key}` : key)
  ))
}

const schemaPaths = leafPaths(createDefaultConfig()).sort()
const visualPaths = Object.keys(runtimeConfigFields).sort()
assert.deepEqual(visualPaths, schemaPaths, "Visual runtime fields must cover every AppConfig leaf")
assert.deepEqual(
  Object.entries(runtimeConfigFields)
    .filter(([, metadata]) => metadata.required)
    .map(([path]) => path)
    .sort(),
  ["auth.passwordPepper", "auth.secret", "email.ingestSecret"],
  "Required post-setup secrets must reject empty values in visual mode",
)
assert.deepEqual(
  Object.entries(runtimeConfigFields)
    .filter(([, metadata]) => metadata.secretAction === "generate")
    .map(([path]) => path)
    .sort(),
  ["auth.emperorBootstrapSecret", "auth.secret", "email.ingestSecret", "monitor.alertBearerToken"],
  "Only independently rotatable secrets may expose the generate action",
)
console.log(JSON.stringify({ ok: true, fields: visualPaths.length }))
