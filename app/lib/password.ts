import {
  createHash,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto"
import {
  AuthWorkloadOverloadedError,
  withScryptCapacity,
} from "./auth-abuse-guard"
import { getConfig } from "./config/runtime"

const SCRYPT_VERSION = "v1"
const SCRYPT_N = 32768
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEY_LENGTH = 32
const SCRYPT_SALT_LENGTH = 16
const MIN_SCRYPT_N = 16384
const MAX_SCRYPT_N = 131072
const MAX_SCRYPT_MEMORY = 128 * 1024 * 1024
const SCRYPT_EXTRA_MEMORY = 32 * 1024 * 1024
const LEGACY_HASH_PATTERN = /^[A-Za-z0-9+/]{43}=$/
const SCRYPT_HASH_PATTERN = /^\$scrypt\$(v\d+)\$N=(\d+),r=(\d+),p=(\d+)\$pepper=([01])\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/

type ScryptParameters = {
  N: number
  r: number
  p: number
}

type ParsedScryptHash = ScryptParameters & {
  peppered: boolean
  salt: Buffer
  expectedKey: Buffer
}

export type PasswordVerification = {
  valid: boolean
  needsRehash: boolean
  scheme: "scrypt" | "legacy" | "unknown"
}

function currentPepper() {
  return getConfig().auth.passwordPepper ?? ""
}

function isPowerOfTwo(value: number) {
  return value > 0 && (value & (value - 1)) === 0
}

function scryptMemoryCost({ N, r }: ScryptParameters) {
  return 128 * N * r
}

function isSafeScryptParameters(parameters: ScryptParameters) {
  return Number.isSafeInteger(parameters.N)
    && isPowerOfTwo(parameters.N)
    && parameters.N >= MIN_SCRYPT_N
    && parameters.N <= MAX_SCRYPT_N
    && Number.isSafeInteger(parameters.r)
    && parameters.r >= 1
    && parameters.r <= 16
    && Number.isSafeInteger(parameters.p)
    && parameters.p >= 1
    && parameters.p <= 4
    && scryptMemoryCost(parameters) <= MAX_SCRYPT_MEMORY
}

function decodeBase64Url(value: string) {
  const decoded = Buffer.from(value, "base64url")
  return decoded.toString("base64url") === value ? decoded : null
}

function parseScryptHash(storedHash: string): ParsedScryptHash | null {
  const match = SCRYPT_HASH_PATTERN.exec(storedHash)
  if (!match || match[1] !== SCRYPT_VERSION) return null

  const parameters = {
    N: Number.parseInt(match[2], 10),
    r: Number.parseInt(match[3], 10),
    p: Number.parseInt(match[4], 10),
  }
  if (!isSafeScryptParameters(parameters)) return null

  const salt = decodeBase64Url(match[6])
  const expectedKey = decodeBase64Url(match[7])
  if (
    !salt
    || salt.length < SCRYPT_SALT_LENGTH
    || salt.length > 64
    || !expectedKey
    || expectedKey.length !== SCRYPT_KEY_LENGTH
  ) {
    return null
  }

  return {
    ...parameters,
    peppered: match[5] === "1",
    salt,
    expectedKey,
  }
}

function passwordMaterial(password: string, peppered: boolean, pepper = currentPepper()) {
  if (!peppered) return Buffer.from(password, "utf8")
  if (!pepper) return null

  return Buffer.concat([
    Buffer.from(password, "utf8"),
    Buffer.from([0]),
    Buffer.from(pepper, "utf8"),
  ])
}

function deriveScryptKey(
  password: string,
  salt: Buffer,
  parameters: ScryptParameters,
  peppered: boolean,
  pepper?: string,
) {
  const material = passwordMaterial(password, peppered, pepper)
  if (!material) return Promise.resolve(null)

  const maxmem = scryptMemoryCost(parameters) + SCRYPT_EXTRA_MEMORY
  return withScryptCapacity(() => (
    new Promise<Buffer>((resolve, reject) => {
      nodeScrypt(material, salt, SCRYPT_KEY_LENGTH, {
        ...parameters,
        maxmem,
      }, (error, derivedKey) => {
        if (error) reject(error)
        else resolve(derivedKey)
      })
    })
  ))
}

function usesCurrentScryptSettings(parsed: ParsedScryptHash, pepper = currentPepper()) {
  return parsed.N === SCRYPT_N
    && parsed.r === SCRYPT_R
    && parsed.p === SCRYPT_P
    && parsed.peppered === Boolean(pepper)
}

function verifyLegacyPassword(
  password: string,
  storedHash: string,
  authSecret = getConfig().auth.secret ?? "",
) {
  if (!LEGACY_HASH_PATTERN.test(storedHash)) return false

  const expected = Buffer.from(storedHash, "base64")
  const actual = createHash("sha256")
    .update(password + authSecret, "utf8")
    .digest()

  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/**
 * 初始化向导会在配置落盘之前调用，因此允许显式传入 pepper；
 * 其余场景默认读取当前生效配置的 auth.passwordPepper。
 */
export async function hashPassword(
  password: string,
  pepper = currentPepper(),
): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_LENGTH)
  const peppered = Boolean(pepper)
  const derivedKey = await deriveScryptKey(password, salt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  }, peppered, pepper)

  if (!derivedKey) {
    throw new Error("PASSWORD_PEPPER_REQUIRED")
  }

  return [
    "",
    "scrypt",
    SCRYPT_VERSION,
    `N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}`,
    `pepper=${peppered ? 1 : 0}`,
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$")
}

export async function verifyPassword(
  password: string,
  storedHash: string,
  options: { passwordPepper?: string; legacyAuthSecret?: string } = {},
): Promise<PasswordVerification> {
  const passwordPepper = options.passwordPepper ?? currentPepper()
  const parsed = parseScryptHash(storedHash)
  if (parsed) {
    try {
      const actualKey = await deriveScryptKey(
        password,
        parsed.salt,
        parsed,
        parsed.peppered,
        passwordPepper,
      )
      const valid = Boolean(
        actualKey
        && actualKey.length === parsed.expectedKey.length
        && timingSafeEqual(actualKey, parsed.expectedKey),
      )
      return {
        valid,
        needsRehash: valid && !usesCurrentScryptSettings(parsed, passwordPepper),
        scheme: "scrypt",
      }
    } catch (error) {
      if (error instanceof AuthWorkloadOverloadedError) throw error
      return { valid: false, needsRehash: false, scheme: "scrypt" }
    }
  }

  if (LEGACY_HASH_PATTERN.test(storedHash)) {
    const valid = verifyLegacyPassword(
      password,
      storedHash,
      options.legacyAuthSecret ?? getConfig().auth.secret ?? "",
    )
    return {
      valid,
      needsRehash: valid,
      scheme: "legacy",
    }
  }

  return { valid: false, needsRehash: false, scheme: "unknown" }
}

export async function comparePassword(password: string, storedHash: string) {
  return (await verifyPassword(password, storedHash)).valid
}
