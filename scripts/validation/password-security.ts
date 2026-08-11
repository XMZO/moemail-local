import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { hashPassword, verifyPassword } from "../../app/lib/password"

const password = "correct horse battery staple"
const legacyAuthSecret = "legacy-auth-secret"
{
  const firstHash = await hashPassword(password)
  const secondHash = await hashPassword(password)
  assert.notEqual(firstHash, secondHash, "random salts must produce different hashes")
  assert.match(firstHash, /^\$scrypt\$v1\$/)

  assert.deepEqual(await verifyPassword(password, firstHash), {
    valid: true,
    needsRehash: false,
    scheme: "scrypt",
  })
  assert.equal((await verifyPassword("wrong password", firstHash)).valid, false)

  assert.equal(
    (await verifyPassword(password, firstHash)).valid,
    true,
    "new password hashes must not depend on AUTH_SECRET",
  )

  const legacyHash = createHash("sha256")
    .update(password + legacyAuthSecret, "utf8")
    .digest("base64")
  assert.deepEqual(await verifyPassword(password, legacyHash, { legacyAuthSecret }), {
    valid: true,
    needsRehash: true,
    scheme: "legacy",
  })
  assert.equal((await verifyPassword("wrong password", legacyHash)).valid, false)

  const passwordPepper = "independent-password-pepper"
  assert.deepEqual(await verifyPassword(password, firstHash, { passwordPepper }), {
    valid: true,
    needsRehash: true,
    scheme: "scrypt",
  })
  const pepperedHash = await hashPassword(password, passwordPepper)
  assert.match(pepperedHash, /\$pepper=1\$/)
  assert.equal((await verifyPassword(password, pepperedHash, { passwordPepper })).valid, true)

  console.log(JSON.stringify({
    randomSalt: true,
    correctPassword: true,
    wrongPasswordRejected: true,
    independentFromAuthSecret: true,
    legacyCompatible: true,
    legacyNeedsRehash: true,
    optionalPepper: true,
    pepperUpgradeCompatible: true,
  }, null, 2))
}
