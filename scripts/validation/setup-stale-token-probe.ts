import assert from "node:assert/strict"
import { existsSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  getConfigStatus,
  reloadConfig,
} from "../../app/lib/config/runtime"
import { closeDatabase } from "../../app/lib/db"
import {
  acquireSetupOperation,
  authorizeSetupRequest,
  ensureSetupToken,
  getSetupTokenPath,
} from "../../app/lib/setup-service"

const readyPath = process.argv[2]
const continuePath = process.argv[3]
if (!readyPath || !continuePath) {
  throw new Error("ready path and continue path are required")
}

const token = ensureSetupToken()
assert.ok(token)

const request = new Request("http://127.0.0.1:3000/api/setup", {
  method: "POST",
  headers: {
    host: "127.0.0.1:3000",
    origin: "http://127.0.0.1:3000",
    "x-moemail-setup-token": token,
  },
})

// 模拟进程 B 已在进程 A 完成初始化前通过第一次鉴权，并缓存了旧 token/状态。
assert.equal(authorizeSetupRequest(request, { consumeBudget: false }), null)
writeFileSync(resolve(readyPath), "ready", "utf8")

const deadline = Date.now() + 20_000
while (!existsSync(resolve(continuePath)) && Date.now() < deadline) {
  // 保持事件循环冻结，防止 1 秒文件 watcher 抢先刷新内存状态；这样才能
  // 确认下面显式 reloadConfig() 正在修复一个真实的旧进程状态。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
}
assert.equal(existsSync(resolve(continuePath)), true, "timed out waiting for setup completion")

const release = acquireSetupOperation()
assert.ok(release, "setup operation lock should be available after process A completed")

try {
  const setupCompletedBeforeReload = getConfigStatus().setupCompleted
  const cachedTokenStillAccepted = ensureSetupToken() === token

  // 与 setup POST/database-probe 路由取得跨进程锁后的关键路径保持一致。
  const reloaded = await reloadConfig()
  const denied = authorizeSetupRequest(request, { consumeBudget: false })

  console.log(`__MOEMAIL_SETUP_STALE_TOKEN_PROBE__${JSON.stringify({
    setupCompletedBeforeReload,
    cachedTokenStillAccepted,
    reloadOk: reloaded.ok,
    setupCompleted: getConfigStatus().setupCompleted,
    deniedStatus: denied?.status ?? null,
    tokenFileExists: existsSync(getSetupTokenPath()),
  })}`)
} finally {
  release()
  await closeDatabase()
}
