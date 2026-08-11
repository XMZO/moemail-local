"use client"

import { createContext, useContext, useEffect, useState } from "react"
import { SessionProvider } from "next-auth/react"
import {
  DEFAULT_PUBLIC_RUNTIME_CONFIG,
  type PublicRuntimeConfig,
} from "@/lib/config/public"

const RuntimeConfigContext = createContext<PublicRuntimeConfig>(DEFAULT_PUBLIC_RUNTIME_CONFIG)

/** 读取服务端下发的运行时配置（轮询间隔、站点地址、可用的 OAuth 登录方式）。 */
export function useRuntimeConfig() {
  return useContext(RuntimeConfigContext)
}

export function Providers({
  children,
  runtimeConfig = DEFAULT_PUBLIC_RUNTIME_CONFIG,
  sessionEnabled = true,
  runtimeRefreshEnabled = true,
}: {
  children: React.ReactNode
  runtimeConfig?: PublicRuntimeConfig
  sessionEnabled?: boolean
  runtimeRefreshEnabled?: boolean
}) {
  const [currentRuntimeConfig, setCurrentRuntimeConfig] = useState(runtimeConfig)

  useEffect(() => {
    setCurrentRuntimeConfig(runtimeConfig)
  }, [runtimeConfig])

  useEffect(() => {
    if (!runtimeRefreshEnabled) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const refresh = async () => {
      try {
        const response = await fetch("/api/runtime-config/public", { cache: "no-store" })
        if (response.ok) {
          const body = await response.json() as { config?: PublicRuntimeConfig }
          if (!cancelled && body.config) {
            setCurrentRuntimeConfig(previous => (
              previous.baseUrl === body.config?.baseUrl
              && previous.emailPollIntervalMs === body.config?.emailPollIntervalMs
              && previous.oauth.github === body.config?.oauth.github
              && previous.oauth.google === body.config?.oauth.google
                ? previous
                : body.config as PublicRuntimeConfig
            ))
          }
        }
      } catch {
        // 短暂重启或网络中断时保留上一份浏览器配置，下次轮询再同步。
      } finally {
        if (!cancelled) timer = setTimeout(refresh, 2_000)
      }
    }

    timer = setTimeout(refresh, 2_000)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [runtimeRefreshEnabled])

  const content = sessionEnabled ? (
    <SessionProvider>{children}</SessionProvider>
  ) : children

  return (
    <RuntimeConfigContext.Provider value={currentRuntimeConfig}>
      {content}
    </RuntimeConfigContext.Provider>
  )
}
