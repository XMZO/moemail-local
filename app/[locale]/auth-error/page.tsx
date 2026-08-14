import { AuthErrorContent } from "@/components/auth/auth-error-content"
import { requireCompletedSetup } from "@/lib/setup-navigation"

export const runtime = "nodejs"

export default async function AuthErrorPage() {
  requireCompletedSetup()
  return <AuthErrorContent />
}
