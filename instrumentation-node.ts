export async function registerNodeRuntime() {
  const { awaitInitialConfigReady } = await import("./app/lib/config/runtime")
  await awaitInitialConfigReady()
}
