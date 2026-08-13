"use client"

import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SHARE_EXPIRY_MAX_MS } from "@/lib/share-expiry"

const PRESETS = [
  { key: "oneHour", value: 60 * 60 * 1_000 },
  { key: "oneDay", value: 24 * 60 * 60 * 1_000 },
  { key: "threeDays", value: 3 * 24 * 60 * 60 * 1_000 },
  { key: "oneWeek", value: 7 * 24 * 60 * 60 * 1_000 },
  { key: "permanent", value: 0 },
] as const

const UNITS = {
  minute: 60 * 1_000,
  hour: 60 * 60 * 1_000,
  day: 24 * 60 * 60 * 1_000,
  week: 7 * 24 * 60 * 60 * 1_000,
  month: 30 * 24 * 60 * 60 * 1_000,
} as const

type Unit = keyof typeof UNITS

interface ShareExpiryPickerProps {
  preset: string
  customValue: string
  customUnit: Unit
  onPresetChange: (value: string) => void
  onCustomValueChange: (value: string) => void
  onCustomUnitChange: (value: Unit) => void
  t: (key: ShareExpiryTranslationKey) => string
}

type ShareExpiryTranslationKey = typeof PRESETS[number]["key"]
  | "custom"
  | "customValue"
  | "customUnit"
  | `units.${Unit}`

export function shareExpiryMilliseconds(preset: string, customValue: string, customUnit: Unit) {
  if (preset !== "custom") return Number(preset)
  const value = Number(customValue)
  const duration = value * UNITS[customUnit]
  return Number.isSafeInteger(value)
    && value > 0
    && Number.isSafeInteger(duration)
    && duration <= SHARE_EXPIRY_MAX_MS
    ? duration
    : Number.NaN
}

export function shareExpiryMaxValue(customUnit: Unit) {
  return Math.floor(SHARE_EXPIRY_MAX_MS / UNITS[customUnit])
}

export function ShareExpiryPicker({
  preset,
  customValue,
  customUnit,
  onPresetChange,
  onCustomValueChange,
  onCustomUnitChange,
  t,
}: ShareExpiryPickerProps) {
  const validDuration = Number.isFinite(shareExpiryMilliseconds(preset, customValue, customUnit))
  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Select value={preset} onValueChange={onPresetChange}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          {PRESETS.map(option => (
            <SelectItem key={option.key} value={option.value.toString()}>{t(option.key)}</SelectItem>
          ))}
          <SelectItem value="custom">{t("custom")}</SelectItem>
        </SelectContent>
      </Select>
      {preset === "custom" && (
        <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
          <Input
            type="number"
            min={1}
            max={shareExpiryMaxValue(customUnit)}
            step={1}
            inputMode="numeric"
            value={customValue}
            onChange={event => onCustomValueChange(event.target.value)}
            aria-label={t("customValue")}
            aria-invalid={!validDuration}
          />
          <Select value={customUnit} onValueChange={value => onCustomUnitChange(value as Unit)}>
            <SelectTrigger aria-label={t("customUnit")}><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(UNITS) as Unit[]).map(unit => (
                <SelectItem key={unit} value={unit}>{t(`units.${unit}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  )
}
