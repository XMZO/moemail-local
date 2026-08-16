"use client"

import { create } from "zustand"
import { Role, ROLES } from "@/lib/permissions"
import { EMAIL_CONFIG } from "@/config"
import { useEffect } from "react"
import { readApiErrorCode } from "@/lib/api-error-client"

interface DomainOption {
  domain: string
  usageWarning: boolean
  inboundMode: "worker" | "imap" | "mailu" | "disabled"
  outboundMode: "resend" | "smtp" | "mailu" | "disabled"
}

interface Config {
  defaultRole: Exclude<Role, typeof ROLES.EMPEROR>
  emailDomains: string
  emailDomainsArray: string[]
  domains: DomainOption[]
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
      const data = await res.json() as Omit<Config, "emailDomainsArray" | "domains"> & {
        domains?: DomainOption[]
      }
      if (typeof data.emailDomains !== "string") throw new Error(CONFIG_FETCH_FAILED)
      const fallbackDomains = data.emailDomains.split(",").filter(Boolean).map(domain => ({
        domain,
        usageWarning: false,
        inboundMode: "worker" as const,
        outboundMode: "disabled" as const,
      }))
      const domains = Array.isArray(data.domains)
        ? data.domains
            .filter(option => typeof option?.domain === "string")
            .map(option => ({ ...option, usageWarning: option.usageWarning === true }))
        : fallbackDomains
      set({
        config: {
          defaultRole: data.defaultRole || ROLES.CIVILIAN,
          emailDomains: data.emailDomains,
          emailDomainsArray: domains.map(option => option.domain),
          domains,
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
