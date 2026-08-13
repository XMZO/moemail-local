import React from "react"
import { Check } from "lucide-react"
import { cn } from "@/lib/utils"

interface CheckboxProps {
  id?: string
  checked?: boolean
  onChange?: (checked: boolean) => void
  className?: string
  disabled?: boolean
  "aria-label"?: string
}

export const Checkbox: React.FC<CheckboxProps> = ({
  id,
  checked = false,
  onChange,
  className,
  disabled = false,
  "aria-label": ariaLabel,
}) => {
  return (
    <span
      className={cn(
        "relative inline-flex h-5 w-5 shrink-0",
        disabled && "cursor-not-allowed opacity-50",
        className
      )}
    >
      <input
        type="checkbox"
        id={id}
        checked={checked}
        onChange={event => onChange?.(event.target.checked)}
        className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        disabled={disabled}
        aria-label={ariaLabel}
      />
      <span className={cn(
        "inline-flex h-5 w-5 items-center justify-center rounded border-2 transition-all duration-200",
        "peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2",
        checked
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input bg-background peer-hover:border-primary/50",
      )}>
        {checked && <Check className="h-3 w-3 animate-in fade-in-0 scale-in-95 text-current duration-200" />}
      </span>
    </span>
  )
}
