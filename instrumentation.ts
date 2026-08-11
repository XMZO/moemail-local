/**
 * Next may evaluate route modules that bind a database-specific schema as soon
 * as the server starts. Finish cold-start config/DB/owner validation first so
 * no module can observe or bind an unverified primary candidate.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNodeRuntime } = await import("./instrumentation-node")
    await registerNodeRuntime()
  }
}
