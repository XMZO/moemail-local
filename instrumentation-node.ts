export async function registerNodeRuntime() {
  const { awaitInitialConfigReady } = await import("./app/lib/config/runtime")
  await awaitInitialConfigReady()
  if (process.env.NEXT_PHASE === "phase-production-build") return
  const { startImapPoller } = await import("./app/lib/imap-inbound")
  startImapPoller()
  const { startMailuPoller } = await import("./app/lib/mailu/inbound")
  startMailuPoller()
  const { startMailuReconciler } = await import("./app/lib/mailu/reconcile")
  startMailuReconciler()
}
