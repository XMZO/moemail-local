import assert from "node:assert/strict"
import {
  issueRegistrationLoginTicket,
  verifyRegistrationLoginTicket,
} from "../../app/lib/registration-login-ticket"

const secret = "registration-login-ticket-validation-secret"
const now = Date.UTC(2026, 7, 14, 0, 0, 0)
const username = "new-member"
const userId = "registration-user-id"

const ticket = issueRegistrationLoginTicket(username, userId, { secret, now })
const tamperedTicket = `${ticket.slice(0, -1)}${ticket.endsWith("A") ? "B" : "A"}`
assert.deepEqual(
  verifyRegistrationLoginTicket(ticket, username, { secret, now }),
  { userId },
)
assert.equal(
  verifyRegistrationLoginTicket(ticket, "another-member", { secret, now }),
  null,
  "a registration ticket must be bound to its username",
)
assert.equal(
  verifyRegistrationLoginTicket(tamperedTicket, username, { secret, now }),
  null,
  "a modified registration ticket must be rejected",
)
assert.equal(
  verifyRegistrationLoginTicket(ticket, username, { secret: `${secret}-wrong`, now }),
  null,
  "a ticket signed by another deployment must be rejected",
)
assert.equal(
  verifyRegistrationLoginTicket(ticket, username, { secret, now: now + 2 * 60 * 1000 }),
  null,
  "an expired registration ticket must be rejected",
)

console.log(JSON.stringify({
  validTicketAccepted: true,
  usernameBound: true,
  tamperingRejected: true,
  deploymentBound: true,
  expirationEnforced: true,
}, null, 2))
