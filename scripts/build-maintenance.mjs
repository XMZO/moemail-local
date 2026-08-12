import { cp, copyFile, mkdir, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { build } from "esbuild"

const outputDirectory = ".next/maintenance"
await rm(outputDirectory, { recursive: true, force: true })
await mkdir(outputDirectory, { recursive: true })

await build({
  entryPoints: ["deploy/docker/maintenance.ts"],
  outfile: `${outputDirectory}/maintenance.mjs`,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["better-sqlite3", "pg-native"],
  minifySyntax: true,
  sourcemap: false,
  legalComments: "none",
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
})

await build({
  entryPoints: ["deploy/docker/config-reader.mjs"],
  outfile: `${outputDirectory}/config-reader.cjs`,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  minifySyntax: true,
  sourcemap: false,
  legalComments: "none",
})

const require = createRequire(import.meta.url)

async function copyRuntimePackage(packageName, files, resolveFrom = process.cwd()) {
  const packageJson = require.resolve(`${packageName}/package.json`, {
    paths: [resolveFrom],
  })
  const sourceRoot = dirname(packageJson)
  const destinationRoot = join(outputDirectory, "node_modules", packageName)
  await mkdir(destinationRoot, { recursive: true })
  for (const file of files) {
    const source = join(sourceRoot, file)
    const destination = join(destinationRoot, file)
    await mkdir(dirname(destination), { recursive: true })
    if (file.endsWith("/")) {
      await cp(source, destination, { recursive: true })
    } else {
      await copyFile(source, destination)
    }
  }
  return sourceRoot
}

const sqliteRoot = await copyRuntimePackage("better-sqlite3", [
  "package.json",
  "LICENSE",
  "lib/",
  "build/Release/better_sqlite3.node",
])
const bindingsRoot = await copyRuntimePackage("bindings", [
  "package.json",
  "LICENSE.md",
  "bindings.js",
], sqliteRoot)
await copyRuntimePackage("file-uri-to-path", [
  "package.json",
  "LICENSE",
  "index.js",
], bindingsRoot)
