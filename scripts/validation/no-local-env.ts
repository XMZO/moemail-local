import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { extname, join } from "node:path"
import { parse } from "yaml"

function visitCompose(value: unknown, path = "") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitCompose(item, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== "object") return
  for (const [key, child] of Object.entries(value)) {
    assert.notEqual(key, "environment", `${path}.environment is forbidden`)
    assert.notEqual(key, "env_file", `${path}.env_file is forbidden`)
    visitCompose(child, path ? `${path}.${key}` : key)
  }
}

for (const file of ["compose.yml", "compose.postgres.yml"]) {
  const composeSource = readFileSync(file, "utf8")
  assert.doesNotMatch(
    composeSource,
    /\$\{[^}]+\}/,
    `${file} must not read shell or .env interpolation`,
  )
  visitCompose(parse(composeSource), file)
}

function sourceFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const child = join(path, entry.name)
    if (entry.isDirectory()) return sourceFiles(child)
    return [".ts", ".tsx", ".js", ".mjs"].includes(extname(entry.name)) ? [child] : []
  })
}

for (const file of [
  ...sourceFiles("app"),
  "instrumentation.ts",
  "instrumentation-node.ts",
  "next.config.ts",
]) {
  const source = readFileSync(file, "utf8")
  let withoutExecutionMode = source.replace(
    /process\.env\.(?:NODE_ENV|NEXT_RUNTIME|NEXT_PHASE)/g,
    "",
  )
  if (file.replaceAll("\\", "/") === "app/lib/postgres-connection.ts") {
    assert.match(source, /Object\.keys\(process\.env\)/)
    assert.match(source, /delete process\.env\[key\]/)
    // 唯一例外只枚举并删除 PG*；它不能读取值或把环境当配置来源。
    withoutExecutionMode = withoutExecutionMode
      .replace("Object.keys(process.env)", "[]")
      .replace("delete process.env[key]", "")
  }
  assert.doesNotMatch(withoutExecutionMode, /process\.env|dotenv\/config/,
    `${file} reads local application configuration from the environment`)
  assert.doesNotMatch(source, /NEXT_PUBLIC_|DATABASE_(?:URL|DRIVER)/,
    `${file} contains a legacy local environment key`)
}

for (const file of readdirSync("deploy/local")) {
  if (!file.endsWith(".service")) continue
  assert.doesNotMatch(
    readFileSync(join("deploy/local", file), "utf8"),
    /^Environment(?:File)?=/m,
    `${file} injects application environment configuration`,
  )
}

assert.equal(existsSync(".env.example"), false)
assert.equal(existsSync("compose.yml"), true)
assert.equal(existsSync("compose.postgres.yml"), true)
assert.equal(existsSync("compose.yaml"), false)
assert.equal(existsSync("compose.postgres.yaml"), false)
console.log(JSON.stringify({
  composeEnvironmentKeysAbsent: true,
  composeInterpolationAbsent: true,
  dualComposeFilesPresent: true,
  legacyComposeYamlRemoved: true,
  appEnvironmentConfigReadsAbsent: true,
  systemdEnvironmentInjectionAbsent: true,
  envExampleRemoved: true,
}, null, 2))
