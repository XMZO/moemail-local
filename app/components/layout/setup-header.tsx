import { ThemeToggle } from "@/components/theme/theme-toggle"
import { LanguageSwitcher } from "@/components/layout/language-switcher"
import { Logo } from "@/components/ui/logo"

export function SetupHeader() {
  return (
    <header className="fixed left-0 right-0 top-0 z-50 h-16 border-b bg-background/80 backdrop-blur-sm">
      <div className="container mx-auto h-full px-4">
        <div className="flex h-full items-center justify-between">
          <Logo />
          <div className="flex items-center gap-x-3 gap-y-4 sm:gap-x-4">
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </div>
      </div>
    </header>
  )
}
