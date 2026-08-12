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
assert.deepEqual(visualPaths, schemaPaths, "视觉运行配置字段必须与 AppConfig 的全部叶字段完全一致")
console.log(JSON.stringify({ ok: true, fields: visualPaths.length }))
