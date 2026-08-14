"use client"

import { Button } from "@/components/ui/button"
import Image from "next/image"
import { useSession } from "next-auth/react"
import { LogIn } from "lucide-react"
import { useRouter } from 'next/navigation'
import { useTranslations } from "next-intl"
import Link from "next/link"
import { cn } from "@/lib/utils"
import { useCurrentOriginSignOut } from "@/hooks/use-current-origin-sign-out"

interface SignButtonProps {
  size?: "default" | "lg"
}

export function SignButton({ size = "default" }: SignButtonProps) {
  const router = useRouter()
  const { data: session, status } = useSession()
  const t = useTranslations("auth.signButton")
  const loading = status === "loading"
  const { isSigningOut, signOutFromCurrentOrigin } = useCurrentOriginSignOut()

  if (loading) {
    return <div className="h-9" />
  }

  if (!session?.user) {
    return (
      <Button onClick={() => router.push("/login")} className={cn("gap-2", size === "lg" ? "px-8" : "")} size={size}>
        <LogIn className={size === "lg" ? "w-5 h-5" : "w-4 h-4"} />
        {t("login")}
      </Button>
    )
  }

  return (
    <div className="flex items-center gap-y-4 gap-x-3 sm:gap-x-4">
      <Link 
        href="/profile"
        className="flex items-center gap-2 hover:opacity-80 transition-opacity"
      >
        {session.user.image && (
          <Image
            src={session.user.image}
            alt={session.user.name || t("userAvatar")}
            width={24}
            height={24}
            className="rounded-full"
          />
        )}
        <span className="hidden sm:inline-block text-sm">{session.user.name}</span>
      </Link>
      <Button onClick={() => void signOutFromCurrentOrigin()} disabled={isSigningOut} variant="outline" className={cn("flex-shrink-0", size === "lg" ? "px-8" : "")} size={size}>
        {t("logout")}
      </Button>
    </div>
  )
}
