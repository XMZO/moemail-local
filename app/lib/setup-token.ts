import { randomBytes } from "node:crypto"
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { getConfigStatus, isSetupCompleted } from "./config/runtime"

type SetupTokenGlobals = typeof globalThis & {
  __moemailSetupToken?: string | null
  __moemailSetupTokenAnnounced?: boolean
}

const setupTokenGlobals = globalThis as SetupTokenGlobals
const SETUP_TOKEN_FILE = "setup-token"

export function generateSecret() {
  return randomBytes(32).toString("base64url")
}

export function getSetupTokenPath() {
  return join(dirname(getConfigStatus().path), SETUP_TOKEN_FILE)
}

function removeTokenFile() {
  try {
    rmSync(getSetupTokenPath(), { force: true })
  } catch (error) {
    console.error(JSON.stringify({
      event: "setup.token.remove.failed",
      path: getSetupTokenPath(),
      message: error instanceof Error ? error.message : String(error),
    }))
  }
}

/** 首次启动的一次性令牌。仅写入 0600 文件，并在每个进程首次加载时输出一次。 */
export function ensureSetupToken() {
  if (isSetupCompleted()) {
    removeTokenFile()
    setupTokenGlobals.__moemailSetupToken = null
    return null
  }

  const path = getSetupTokenPath()
  if (setupTokenGlobals.__moemailSetupToken) {
    try {
      if (readFileSync(path, "utf8").trim() === setupTokenGlobals.__moemailSetupToken) {
        return setupTokenGlobals.__moemailSetupToken
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    // 另一个进程可能已完成 setup 并删除 token，或轮换了无效文件；
    // 绝不继续接受仅存在于本进程内存中的旧令牌。
    setupTokenGlobals.__moemailSetupToken = null
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })

  let token: string
  try {
    token = generateSecret()
    writeFileSync(path, `${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    token = readFileSync(path, "utf8").trim()
  }

  if (Buffer.byteLength(token, "utf8") < 32 || /\s/.test(token)) {
    throw new Error("SETUP_TOKEN_INVALID")
  }

  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows 与部分文件系统不支持 POSIX 权限位。
  }

  setupTokenGlobals.__moemailSetupToken = token
  if (!setupTokenGlobals.__moemailSetupTokenAnnounced) {
    setupTokenGlobals.__moemailSetupTokenAnnounced = true
    console.warn(JSON.stringify({
      event: "setup.token.ready",
      token,
      path,
      warning: "SETUP_TOKEN_CAN_CREATE_EMPEROR",
    }))
  }
  return token
}

export function removeSetupToken(options: { log?: boolean } = {}) {
  removeTokenFile()
  setupTokenGlobals.__moemailSetupToken = null
  if (options.log !== false) {
    console.log(JSON.stringify({ event: "setup.token.removed", path: getSetupTokenPath() }))
  }
}
