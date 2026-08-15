import { normalizeMailboxAddress } from "./email-address"

export const MAX_OUTBOUND_RECIPIENTS = 50

const FULL_WIDTH_RECIPIENT_SEPARATORS = /[\uFF0C\uFF1B]/gu
const RECIPIENT_SEPARATOR_PATTERN = /[\s,;]+/u

export function normalizeRecipientSeparators(value: string) {
  return value.replace(FULL_WIDTH_RECIPIENT_SEPARATORS, separator => (
    separator.charCodeAt(0) === 0xFF0C ? "," : ";"
  ))
}

export function splitRecipientInput(value: string) {
  return normalizeRecipientSeparators(value)
    .split(RECIPIENT_SEPARATOR_PATTERN)
    .filter(Boolean)
}

export function parseOutboundRecipients(values: string | string[]) {
  const tokens = (Array.isArray(values) ? values : [values])
    .flatMap(splitRecipientInput)
  const recipients: string[] = []
  const invalid: string[] = []
  const seen = new Set<string>()

  for (const token of tokens) {
    const recipient = token.length <= 320 ? normalizeMailboxAddress(token) : null
    if (!recipient) {
      invalid.push(token.slice(0, 320))
      continue
    }
    if (!seen.has(recipient)) {
      seen.add(recipient)
      recipients.push(recipient)
    }
  }

  return {
    recipients,
    invalid,
    tooMany: recipients.length > MAX_OUTBOUND_RECIPIENTS,
  }
}
