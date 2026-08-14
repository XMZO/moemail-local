import { Header } from "@/components/layout/header"
import { ThreeColumnLayout } from "@/components/emails/three-column-layout"
import { NoPermissionDialog } from "@/components/no-permission-dialog"
import { redirect } from "next/navigation"
import { PERMISSIONS } from "@/lib/permissions"
import { requireCompletedSetup } from "@/lib/setup-navigation"

export const runtime = "nodejs"

export default async function MoePage() {
  requireCompletedSetup()
  const { auth } = await import("@/lib/auth")
  const session = await auth()
  
  if (!session?.user) {
    redirect("/")
  }

  const canManageEmail = session.user.permissions?.includes(PERMISSIONS.VIEW_EMAIL) ?? false

  return (
    <div className="bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 h-screen">
      <div className="container mx-auto h-full px-4 lg:px-8 max-w-[1600px]">
        <Header />
        <main className="h-full">
          <ThreeColumnLayout />
          {!canManageEmail && <NoPermissionDialog />}
        </main>
      </div>
    </div>
  )
}

