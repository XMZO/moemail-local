"use client"

import type { User } from "next-auth"
import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import Image from "next/image"
import { useRouter, useSearchParams } from "next/navigation"
import { Crown, Gem, Github, KeyRound, Mail, Settings, SlidersHorizontal, Sword, Type, User2, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PERMISSIONS, ROLES } from "@/lib/permissions"
import { useRolePermission } from "@/hooks/use-role-permission"
import { useCurrentOriginSignOut } from "@/hooks/use-current-origin-sign-out"
import { AccessPolicyPanel } from "./access-policy-panel"
import { ApiKeyPanel } from "./api-key-panel"
import { AppearancePanel } from "./appearance-panel"
import { DomainPolicyPanel } from "./domain-policy-panel"
import { PromotePanel } from "./promote-panel"
import { RuntimeConfigPanel } from "./runtime-config-panel"
import { MyQuotaPanel } from "./my-quota-panel"
import { WebsiteConfigPanel } from "./website-config-panel"
import { WebhookConfig } from "./webhook-config"

interface ProfileCardProps { user: User }

const profileTabs = ["account", "domains", "access", "users", "site", "appearance", "runtime", "webhook", "keys"] as const
type ProfileTab = typeof profileTabs[number]

const roleConfigs = {
  emperor: { key: "EMPEROR", icon: Crown },
  duke: { key: "DUKE", icon: Gem },
  knight: { key: "KNIGHT", icon: Sword },
  civilian: { key: "CIVILIAN", icon: User2 },
} as const

const providerConfigs = {
  google: {
    label: "Google",
    className: "text-red-500 bg-red-500/10",
    icon: (props: React.SVGProps<SVGSVGElement>) => <svg viewBox="0 0 24 24" {...props}><path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>,
  },
  github: { label: "GitHub", className: "text-primary bg-primary/10", icon: Github },
} as const

function TabLabel({ icon: Icon, children }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return <span className="flex items-center gap-1.5"><Icon className="h-4 w-4" />{children}</span>
}

export function ProfileCard({ user }: ProfileCardProps) {
  const t = useTranslations("profile.card")
  const tAuth = useTranslations("auth.signButton")
  const tWebhook = useTranslations("profile.webhook")
  const tNav = useTranslations("common.nav")
  const tFormat = useTranslations("common.format")
  const tAdminNav = useTranslations("admin.navigation")
  const { isSigningOut, signOutFromCurrentOrigin } = useCurrentOriginSignOut()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { checkPermission } = useRolePermission()
  const canManageWebhook = checkPermission(PERMISSIONS.MANAGE_WEBHOOK)
  const canManageApiKey = checkPermission(PERMISSIONS.MANAGE_API_KEY)
  const canPromote = checkPermission(PERMISSIONS.PROMOTE_USER)
  const canManageConfig = checkPermission(PERMISSIONS.MANAGE_CONFIG)
  const canManageMailu = checkPermission(PERMISSIONS.MANAGE_MAILU)
  const isEmperor = user.roles?.some(role => role.name === ROLES.EMPEROR) ?? false
  const allowedTabs = useMemo(() => new Set<ProfileTab>([
    "account",
    ...(canManageConfig || canManageMailu ? ["domains"] as const : []),
    ...(canManageConfig ? ["site", "appearance"] as const : []),
    ...(isEmperor ? ["access", "runtime"] as const : []),
    ...(canPromote ? ["users"] as const : []),
    ...(canManageWebhook ? ["webhook"] as const : []),
    ...(canManageApiKey ? ["keys"] as const : []),
  ]), [canManageApiKey, canManageConfig, canManageMailu, canManageWebhook, canPromote, isEmperor])
  const requestedTab = searchParams.get("tab")
  const requestedActiveTab: ProfileTab = profileTabs.includes(requestedTab as ProfileTab)
    && allowedTabs.has(requestedTab as ProfileTab)
    ? requestedTab as ProfileTab
    : "account"
  const [activeTab, setActiveTab] = useState<ProfileTab>(requestedActiveTab)
  const [visitedTabs, setVisitedTabs] = useState<Set<ProfileTab>>(
    () => new Set([requestedActiveTab]),
  )

  useEffect(() => {
    setActiveTab(requestedActiveTab)
    setVisitedTabs(previous => {
      if (previous.has(requestedActiveTab)) return previous
      return new Set(previous).add(requestedActiveTab)
    })
  }, [requestedActiveTab])

  useEffect(() => {
    const preload = () => {
      setVisitedTabs(previous => {
        if (previous.size === allowedTabs.size && [...allowedTabs].every(tab => previous.has(tab))) {
          return previous
        }
        return new Set([...previous, ...allowedTabs])
      })
    }
    const idleWindow = window as typeof window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
      cancelIdleCallback?: (handle: number) => void
    }
    if (idleWindow.requestIdleCallback) {
      const handle = idleWindow.requestIdleCallback(preload, { timeout: 300 })
      return () => idleWindow.cancelIdleCallback?.(handle)
    }
    const handle = window.setTimeout(preload, 120)
    return () => window.clearTimeout(handle)
  }, [allowedTabs])

  const changeTab = (value: string) => {
    const tab = value as ProfileTab
    if (!allowedTabs.has(tab) || tab === activeTab) return
    setActiveTab(tab)
    setVisitedTabs(previous => new Set(previous).add(tab))
    const next = new URLSearchParams(searchParams.toString())
    if (tab === "account") next.delete("tab")
    else next.set("tab", tab)
    const search = next.toString()
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`,
    )
  }

  const persistentTabClass = "data-[state=inactive]:hidden data-[state=active]:animate-in data-[state=active]:fade-in-0 data-[state=active]:duration-150"

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <Tabs value={activeTab} onValueChange={changeTab} className="w-full">
        <div className="overflow-x-auto pb-1">
          <TabsList className="h-auto min-w-max justify-start">
            <TabsTrigger value="account"><TabLabel icon={User2}>{tAdminNav("account")}</TabLabel></TabsTrigger>
            {(canManageConfig || canManageMailu) && <TabsTrigger value="domains"><TabLabel icon={Mail}>{tAdminNav("domains")}</TabLabel></TabsTrigger>}
            {isEmperor && <TabsTrigger value="access"><TabLabel icon={SlidersHorizontal}>{tAdminNav("access")}</TabLabel></TabsTrigger>}
            {canPromote && <TabsTrigger value="users"><TabLabel icon={Users}>{tAdminNav("users")}</TabLabel></TabsTrigger>}
            {canManageConfig && <TabsTrigger value="site"><TabLabel icon={Settings}>{tAdminNav("site")}</TabLabel></TabsTrigger>}
            {canManageConfig && <TabsTrigger value="appearance"><TabLabel icon={Type}>{tAdminNav("appearance")}</TabLabel></TabsTrigger>}
            {isEmperor && <TabsTrigger value="runtime"><TabLabel icon={SlidersHorizontal}>{tAdminNav("runtime")}</TabLabel></TabsTrigger>}
            {canManageWebhook && <TabsTrigger value="webhook"><TabLabel icon={Settings}>{tAdminNav("webhook")}</TabLabel></TabsTrigger>}
            {canManageApiKey && <TabsTrigger value="keys"><TabLabel icon={KeyRound}>{tAdminNav("apiKey")}</TabLabel></TabsTrigger>}
          </TabsList>
        </div>

        {visitedTabs.has("account") && <TabsContent value="account" forceMount className={persistentTabClass}>
          <div className="space-y-4">
          <div className="rounded-lg border-2 border-primary/20 bg-background p-4 sm:p-6">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
              <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-full bg-primary/10 ring-2 ring-primary/20">
                {user.image ? <Image src={user.image} alt={user.name || tAuth("userAvatar")} fill sizes="80px" className="object-cover" /> : <User2 className="m-5 h-10 w-10 text-primary" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><h2 className="truncate text-xl font-bold">{user.name || user.username}</h2>{user.providers?.map(provider => { const config = providerConfigs[provider as keyof typeof providerConfigs]; if (!config) return null; const Icon = config.icon; return <span key={provider} className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${config.className}`}><Icon className="h-3 w-3" />{config.label}</span> })}</div>
                <p className="mt-1 truncate text-sm text-muted-foreground">{user.email || tFormat("labelValue", { label: t("name"), value: user.username ?? "" })}</p>
                <div className="mt-2 flex flex-wrap gap-2">{user.roles?.map(({ name }) => { const role = roleConfigs[name as keyof typeof roleConfigs]; if (!role) return null; const Icon = role.icon; return <span key={name} className="flex items-center gap-1 rounded bg-primary/10 px-2 py-0.5 text-xs text-primary"><Icon className="h-3 w-3" />{t(`roles.${role.key}` as never)}</span> })}</div>
              </div>
              <div className="flex shrink-0 gap-2 sm:flex-col"><Button onClick={() => router.push("/moe")} className="flex-1 gap-2"><Mail className="h-4 w-4" />{tNav("backToMailbox")}</Button><Button variant="outline" disabled={isSigningOut} onClick={() => void signOutFromCurrentOrigin()} className="flex-1">{tAuth("logout")}</Button></div>
            </div>
          </div>
          <MyQuotaPanel />
          </div>
        </TabsContent>}
        {(canManageConfig || canManageMailu) && visitedTabs.has("domains") && <TabsContent value="domains" forceMount className={persistentTabClass}><DomainPolicyPanel canManageConfig={canManageConfig} canManageMailu={canManageMailu} /></TabsContent>}
        {isEmperor && visitedTabs.has("access") && <TabsContent value="access" forceMount className={persistentTabClass}><AccessPolicyPanel /></TabsContent>}
        {canPromote && visitedTabs.has("users") && <TabsContent value="users" forceMount className={persistentTabClass}><PromotePanel /></TabsContent>}
        {canManageConfig && visitedTabs.has("site") && <TabsContent value="site" forceMount className={persistentTabClass}><WebsiteConfigPanel /></TabsContent>}
        {canManageConfig && visitedTabs.has("appearance") && <TabsContent value="appearance" forceMount className={persistentTabClass}><AppearancePanel allowAdvanced={isEmperor} /></TabsContent>}
        {isEmperor && visitedTabs.has("runtime") && <TabsContent value="runtime" forceMount className={persistentTabClass}><RuntimeConfigPanel /></TabsContent>}
        {canManageWebhook && visitedTabs.has("webhook") && <TabsContent value="webhook" forceMount className={persistentTabClass}><div className="rounded-lg border-2 border-primary/20 bg-background p-4 sm:p-6"><div className="mb-5 flex items-center gap-2"><Settings className="h-5 w-5 text-primary" /><h2 className="font-semibold">{tWebhook("title")}</h2></div><WebhookConfig /></div></TabsContent>}
        {canManageApiKey && visitedTabs.has("keys") && <TabsContent value="keys" forceMount className={persistentTabClass}><ApiKeyPanel /></TabsContent>}
      </Tabs>
    </div>
  )
}
