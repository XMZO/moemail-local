"use client"

import { useId, useRef, type KeyboardEvent } from "react"
import { X } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  MAX_OUTBOUND_RECIPIENTS,
  normalizeRecipientSeparators,
  parseOutboundRecipients,
} from "@/lib/outbound-recipients"

interface RecipientInputProps {
  recipients: string[]
  draft: string
  error: string
  disabled?: boolean
  onRecipientsChange: (recipients: string[]) => void
  onDraftChange: (draft: string) => void
  onErrorChange: (error: string) => void
}

export function RecipientInput({
  recipients,
  draft,
  error,
  disabled,
  onRecipientsChange,
  onDraftChange,
  onErrorChange,
}: RecipientInputProps) {
  const t = useTranslations("emails.send")
  const inputId = useId()
  const errorId = useId()
  const inputRef = useRef<HTMLInputElement>(null)

  const parseNext = (raw: string) => {
    const parsed = parseOutboundRecipients([...recipients, raw])
    if (parsed.invalid.length > 0) {
      onErrorChange(t("recipientInvalid", { value: parsed.invalid[0] }))
      return null
    }
    if (parsed.tooMany) {
      onErrorChange(t("recipientLimit", { maximum: MAX_OUTBOUND_RECIPIENTS }))
      return null
    }
    return parsed.recipients
  }

  const commitDraft = (raw = draft) => {
    if (!raw.trim()) return true
    const next = parseNext(raw)
    if (!next) return false
    onRecipientsChange(next)
    onDraftChange("")
    onErrorChange("")
    return true
  }

  const editRecipient = (address: string) => {
    const next = parseNext(draft)
    if (!next) {
      inputRef.current?.focus()
      return
    }
    onRecipientsChange(next.filter(recipient => recipient !== address))
    onDraftChange(address)
    onErrorChange("")
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace" && !draft && recipients.length > 0) {
      event.preventDefault()
      editRecipient(recipients[recipients.length - 1])
      return
    }
    if (["Enter", ",", ";", " "].includes(normalizeRecipientSeparators(event.key))) {
      event.preventDefault()
      void commitDraft()
      return
    }
    if (event.key === "Tab" && draft && !commitDraft()) event.preventDefault()
  }

  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="text-sm font-medium">{t("to")}</label>
      <div
        className={`flex max-h-32 min-h-10 min-w-0 flex-wrap items-center gap-1.5 overflow-y-auto rounded-md border border-input bg-background px-2 py-1.5 ring-offset-background transition-shadow focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 ${error ? "border-destructive" : ""}`}
        onClick={() => inputRef.current?.focus()}
      >
        {recipients.map(address => (
          <span key={address} className="flex max-w-full items-center gap-0.5 rounded-md border bg-muted px-1.5 py-0.5 text-sm">
            <button
              type="button"
              className="min-w-0 max-w-[min(28rem,70vw)] truncate px-0.5 text-left font-mono text-xs hover:underline"
              title={t("recipientEdit", { address })}
              aria-label={t("recipientEdit", { address })}
              disabled={disabled}
              onMouseDown={event => event.preventDefault()}
              onClick={() => editRecipient(address)}
            >
              {address}
            </button>
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
              title={t("recipientRemove", { address })}
              aria-label={t("recipientRemove", { address })}
              disabled={disabled}
              onMouseDown={event => event.preventDefault()}
              onClick={() => {
                onRecipientsChange(recipients.filter(recipient => recipient !== address))
                onErrorChange("")
              }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          inputMode="email"
          className="h-7 min-w-[12rem] flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
          value={draft}
          placeholder={recipients.length === 0 ? t("toPlaceholder") : t("recipientInput")}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          onChange={event => {
            const normalized = normalizeRecipientSeparators(event.target.value)
            onDraftChange(normalized)
            onErrorChange("")
            if (/[\s,;]/u.test(normalized)) void commitDraft(normalized)
          }}
          onKeyDown={handleKeyDown}
          onBlur={() => void commitDraft()}
        />
      </div>
      {error && <p id={errorId} role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
