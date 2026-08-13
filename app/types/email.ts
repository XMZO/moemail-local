export interface ExpiryOption {
  key: "oneHour" | "oneDay" | "threeDays" | "permanent"
  value: number
}

export const EXPIRY_OPTIONS: ExpiryOption[] = [
  { key: "oneHour", value: 1000 * 60 * 60 },
  { key: "oneDay", value: 1000 * 60 * 60 * 24 },
  { key: "threeDays", value: 1000 * 60 * 60 * 24 * 3 },
  { key: "permanent", value: 0 },
]
