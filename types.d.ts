/// <reference types="@cloudflare/workers-types" />


declare global {
  interface Window {
    turnstile?: {
      render: (element: HTMLElement | string, options: Record<string, unknown>) => string
      reset: (widgetId?: string) => void
      remove: (widgetId: string) => void
    }
  }

}

declare module "next-auth" {
  interface User {
    roles?: { name: string }[]
    username?: string | null
    providers?: string[]
    permissions?: string[]
    quotas?: Record<string, number>
  }

  interface Session {
    user: User
  }
}

export {}
