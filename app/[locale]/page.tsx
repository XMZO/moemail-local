import { Header } from "@/components/layout/header"
import { HomeContent } from "@/components/home/home-content"
import { requireCompletedSetup } from "@/lib/setup-navigation"

export const runtime = "nodejs"

export default async function Home() {
  requireCompletedSetup()
  const { auth } = await import("@/lib/auth")
  const session = await auth()

  return (
    <div className="bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 min-h-screen">
      <div className="container mx-auto px-4 lg:px-8 max-w-[1600px]">
        <Header />
        <HomeContent isLoggedIn={Boolean(session)} />
      </div>
    </div>
  )
}

