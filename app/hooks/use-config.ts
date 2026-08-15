"use client"

import { create } from "zustand"
import { Role, ROLES } from "@/lib/permissions"
import { EMAIL_CONFIG } from "@/config"
import { useEffect } from "react"
import { readApiErrorCode } from "@/lib/api-error-client"

interface Config {
  defaultRole: Exclude<Role, typeof ROLES.EMPEROR>
  emailDomains: string
  emailDomainsArray: string[]
  adminContact: string
  maxEmails: number
}

interface ConfigStore {
  config: Config | null
  loading: boolean
  error: string | null
  fetch: () => Promise<void>
}

const CONFIG_FETCH_FAILED = "CONFIG_FETCH_FAILED"

const useConfigStore = create<ConfigStore>((set) => ({
  config: null,
  loading: false,
  error: null,
  fetch: async () => {
    try {
      set({ loading: true, error: null })
      const res = await fetch("/api/config")
      if (!res.ok) {
        await readApiErrorCode(res, CONFIG_FETCH_FAILED)
        throw new Error(CONFIG_FETCH_FAILED)
      }
      const data = await res.json() as Config
      if (typeof data.emailDomains !== "string") throw new Error(CONFIG_FETCH_FAILED)
      set({
        config: {
          defaultRole: data.defaultRole || ROLES.CIVILIAN,
          emailDomains: data.emailDomains,
          emailDomainsArray: data.emailDomains.split(',').filter(Boolean),
          adminContact: data.adminContact || "",
          maxEmails: Number(data.maxEmails) || EMAIL_CONFIG.MAX_ACTIVE_EMAILS
        },
        loading: false
      })
    } catch {
      set({ 
        error: CONFIG_FETCH_FAILED,
        loading: false 
      })
    }
  }
}))

export function useConfig() {
  const config = useConfigStore(state => state.config)
  const loading = useConfigStore(state => state.loading)
  const error = useConfigStore(state => state.error)
  const fetchConfig = useConfigStore(state => state.fetch)

  useEffect(() => {
    if (!config && !loading) {
      void fetchConfig()
    }
  }, [config, loading, fetchConfig])

  return { config, loading, error, fetch: fetchConfig }
}
