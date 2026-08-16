"use client"

import { Moon, Sun, SunMoon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"

export function ThemeToggle() {
  const t = useTranslations("common.actions")
  const { theme, setTheme } = useTheme()
  const automatic = theme !== "light" && theme !== "dark"

  const cycleTheme = () => {
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light"

    if (automatic) {
      setTheme(systemTheme === "dark" ? "light" : "dark")
      return
    }

    if (theme !== systemTheme) {
      setTheme(systemTheme)
      return
    }

    setTheme("system")
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={cycleTheme}
      className="relative rounded-full"
    >
      <Sun className={`h-5 w-5 transition-all ${theme === "light" ? "rotate-0 scale-100 opacity-100" : "-rotate-90 scale-0 opacity-0"}`} />
      <Moon className={`absolute h-5 w-5 transition-all ${theme === "dark" ? "rotate-0 scale-100 opacity-100" : "rotate-90 scale-0 opacity-0"}`} />
      <SunMoon className={`absolute h-5 w-5 transition-all ${automatic ? "rotate-0 scale-100 opacity-100" : "rotate-90 scale-0 opacity-0"}`} />
      <span className="sr-only">{t("toggleTheme")}</span>
    </Button>
  )
}
