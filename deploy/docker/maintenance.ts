const [command = "self-check", ...arguments_] = process.argv.slice(2)

export {}

// Keep the argv contract used by the existing maintenance scripts: argv[2]
// is the first user-supplied argument (for example, a restore archive).
process.argv = [process.argv[0] ?? "node", command, ...arguments_]

switch (command) {
  case "migrate":
    await import("../../scripts/database/migrate")
    break
  case "verify":
    await import("../../scripts/database/verify")
    break
  case "cleanup":
    await import("../../scripts/cleanup")
    break
  case "backup":
    await import("../../scripts/sqlite/backup")
    break
  case "restore":
    await import("../../scripts/database/restore")
    break
  case "monitor":
    await import("../../scripts/ops/monitor")
    break
  case "offsite-backup":
    await import("../../scripts/ops/offsite-backup")
    break
  case "self-check": {
    const [{ createDefaultConfig }, { postgresPoolConfig }, sqlite] = await Promise.all([
      import("../../app/lib/config/schema"),
      import("../../app/lib/db"),
      import("better-sqlite3"),
    ])
    const config = createDefaultConfig()
    const poolConfig = postgresPoolConfig({
      ...config,
      database: {
        ...config.database,
        driver: "postgres",
        postgres: {
          ...config.database.postgres,
          url: "postgresql://bundle-user:bundle-password@127.0.0.1:5432/bundle-db",
        },
      },
    })
    const Database = sqlite.default
    if (
      config.database.driver !== "sqlite"
      || typeof Database !== "function"
      || poolConfig.host !== "127.0.0.1"
      || poolConfig.port !== 5432
      || poolConfig.database !== "bundle-db"
    ) {
      throw new Error("Maintenance bundle self-check failed")
    }
    const database = new Database(":memory:")
    try {
      const row = database.prepare("SELECT 1 AS ready").get() as { ready?: number }
      if (row.ready !== 1) throw new Error("SQLite native binding self-check failed")
    } finally {
      database.close()
    }
    console.log(JSON.stringify({
      maintenance: "ready",
      defaultDriver: config.database.driver,
      sqliteNativeBinding: true,
      postgresTargetMaterialized: true,
    }))
    break
  }
  default:
    console.error(
      "Usage: maintenance.mjs migrate | verify | cleanup | backup | restore | monitor | offsite-backup | self-check",
    )
    process.exitCode = 64
}
