"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Crown, Globe2, Loader2, RotateCcw, Save, Search, ShieldCheck, Trash2, UserCog } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  RoleMailQuotaEditor,
  UserMailQuotaEditor,
  type MailDirection,
  type MailQuotaOverride,
  type MailQuotaPolicy,
  type MailQuotaUsage,
} from "@/components/profile/mail-quota-editor"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useToast } from "@/components/ui/use-toast"
import { readApiErrorCode } from "@/lib/api-error-client"
import { LocalizedUiError, localizedUiErrorMessage } from "@/lib/localized-ui-error"
import { ROLES, type Permission, type Role } from "@/lib/permissions"
import { normalizeMailboxCreationName } from "@/lib/email-address"

const quotaKeys = ["maxActiveMailboxes", "maxMailboxLifetimeDays", "maxMessageBytes"] as const
type QuotaKey = typeof quotaKeys[number]
type DomainAccessMode = "allow" | "receive" | "send" | "deny"
type DomainAccessPolicy = { default: DomainAccessMode; domains: Record<string, DomainAccessMode> }
type DomainAccessOverride = { default?: DomainAccessMode; domains?: Record<string, DomainAccessMode> }
type RolePolicy = {
  permissions: Record<Permission, boolean>
  quotas: Record<QuotaKey, number>
  domainAccess: DomainAccessPolicy
  sendQuota: MailQuotaPolicy
  receiveQuota: MailQuotaPolicy
}
type UserOverride = {
  permissions: Partial<Record<Permission, boolean>>
  quotas: Partial<Record<QuotaKey, number>>
  domainAccess?: DomainAccessOverride
  sendQuota?: MailQuotaOverride
  receiveQuota?: MailQuotaOverride
}
interface AccessPolicies { version: 4; roles: Record<Role, RolePolicy>; users: Record<string, UserOverride> }
interface UserItem { id: string; name: string | null; username: string | null; email: string | null; role: string | null; accessOverride: UserOverride | null }
interface MailboxBlock {
  id: string
  userId: string | null
  scopeKey: string
  localPart: string
  domain: string
  user?: { id: string; name: string | null; username: string | null; email: string | null } | null
}

const roles = [ROLES.EMPEROR, ROLES.DUKE, ROLES.KNIGHT, ROLES.CIVILIAN] as const
const domainModes: DomainAccessMode[] = ["allow", "receive", "send", "deny"]
const roleTranslationKeys = { emperor: "EMPEROR", duke: "DUKE", knight: "KNIGHT", civilian: "CIVILIAN" } as const
const emptyOverride = (): UserOverride => ({ permissions: {}, quotas: {} })

function copyOverride(value: UserOverride | null | undefined) {
  return value ? structuredClone(value) : emptyOverride()
}

function roleForUser(user: UserItem | null): Role {
  return roles.includes(user?.role as Role) ? user!.role as Role : ROLES.CIVILIAN
}

function DomainModeSelect({ value, onChange, disabled, label }: {
  value: DomainAccessMode
  onChange: (value: DomainAccessMode) => void
  disabled?: boolean
  label?: string
}) {
  const t = useTranslations("admin.access.domains")
  return (
    <Select value={value} onValueChange={next => onChange(next as DomainAccessMode)} disabled={disabled}>
      <SelectTrigger aria-label={label} className="h-8 w-[8.75rem]"><SelectValue /></SelectTrigger>
      <SelectContent>{domainModes.map(mode => <SelectItem key={mode} value={mode}>{t(`modes.${mode}` as never)}</SelectItem>)}</SelectContent>
    </Select>
  )
}

export function AccessPolicyPanel() {
  const t = useTranslations("admin.access")
  const tRoles = useTranslations("profile.card.roles")
  const tFormat = useTranslations("common.format")
  const tApi = useTranslations("api")
  const { toast } = useToast()
  const [policies, setPolicies] = useState<AccessPolicies | null>(null)
  const [defaults, setDefaults] = useState<AccessPolicies | null>(null)
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [domains, setDomains] = useState<string[]>([])
  const [role, setRole] = useState<Role>(ROLES.DUKE)
  const [direction, setDirection] = useState<MailDirection>("send")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [users, setUsers] = useState<UserItem[]>([])
  const [search, setSearch] = useState("")
  const [selectedUserId, setSelectedUserId] = useState("")
  const [override, setOverride] = useState<UserOverride>(emptyOverride)
  const [usageRevision, setUsageRevision] = useState(0)
  const [roleUsage, setRoleUsage] = useState<MailQuotaUsage | null>(null)
  const [userUsage, setUserUsage] = useState<MailQuotaUsage | null>(null)
  const [blocks, setBlocks] = useState<MailboxBlock[]>([])
  const [blockLocalPart, setBlockLocalPart] = useState("")
  const [blockDomain, setBlockDomain] = useState("")
  const [blockScope, setBlockScope] = useState<"global" | "user">("global")
  const [blockUserId, setBlockUserId] = useState("")
  const normalizedBlockLocalPart = normalizeMailboxCreationName(blockLocalPart)
  const invalidBlockLocalPart = blockLocalPart.length > 0 && !normalizedBlockLocalPart

  const loadPolicies = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const response = await fetch("/api/access-policies", { cache: "no-store" })
      const body = await response.clone().json() as { policies?: AccessPolicies; defaults?: AccessPolicies; permissions?: Permission[]; domains?: string[] }
      if (!response.ok || !body.policies || !body.defaults || !body.permissions || !body.domains) throw new LocalizedUiError(tApi(await readApiErrorCode(response, "ACCESS_POLICIES_READ_FAILED") as never))
      setPolicies(body.policies)
      setDefaults(body.defaults)
      setPermissions(body.permissions)
      setDomains(body.domains)
      setBlockDomain(current => current || body.domains![0] || "")
    } catch (caught) {
      setError(localizedUiErrorMessage(caught, t("errors.loadPolicies")))
    } finally {
      setLoading(false)
    }
  }, [t, tApi])

  const loadUsers = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page: "1", pageSize: "100" })
      if (search.trim()) params.set("search", search.trim())
      const response = await fetch(`/api/roles/users?${params}`, { cache: "no-store" })
      const body = await response.clone().json() as { users?: UserItem[] }
      if (!response.ok || !body.users) throw new LocalizedUiError(tApi(await readApiErrorCode(response, "USERS_READ_FAILED") as never))
      setUsers(body.users)
    } catch (caught) {
      setError(localizedUiErrorMessage(caught, t("errors.loadUsers")))
    }
  }, [search, t, tApi])

  const loadBlocks = useCallback(async () => {
    try {
      const response = await fetch("/api/access-policies/mailbox-blocks", { cache: "no-store" })
      const body = await response.clone().json() as { blocks?: MailboxBlock[] }
      if (!response.ok || !body.blocks) throw new LocalizedUiError(tApi(await readApiErrorCode(response, "MAILBOX_BLOCKS_READ_FAILED") as never))
      setBlocks(body.blocks)
    } catch (caught) {
      setError(localizedUiErrorMessage(caught, t("errors.loadBlocks")))
    }
  }, [t, tApi])

  useEffect(() => { void Promise.all([loadPolicies(), loadBlocks()]) }, [loadBlocks, loadPolicies])
  useEffect(() => { const timer = setTimeout(() => void loadUsers(), 200); return () => clearTimeout(timer) }, [loadUsers])

  const selectedUser = useMemo(() => users.find(user => user.id === selectedUserId) ?? null, [selectedUserId, users])
  const selectedUserRole = roleForUser(selectedUser)
  const rolePolicy = policies?.roles[role]
  const emperorRole = role === ROLES.EMPEROR
  const selectedUserIsEmperor = selectedUserRole === ROLES.EMPEROR

  useEffect(() => {
    const controller = new AbortController()
    setRoleUsage(null)
    void fetch(`/api/access-policies/usage?role=${role}&direction=${direction}`, { cache: "no-store", signal: controller.signal })
      .then(async response => { const body = await response.json() as { usage?: MailQuotaUsage }; if (response.ok && body.usage) setRoleUsage(body.usage) })
      .catch(error => { if (error instanceof Error && error.name !== "AbortError") console.error("access_policy.role_usage_failed", error) })
    return () => controller.abort()
  }, [direction, role, usageRevision])

  useEffect(() => {
    if (!selectedUserId) { setUserUsage(null); return }
    const controller = new AbortController()
    setUserUsage(null)
    void fetch(`/api/access-policies/usage?userId=${encodeURIComponent(selectedUserId)}&direction=${direction}`, { cache: "no-store", signal: controller.signal })
      .then(async response => { const body = await response.json() as { usage?: MailQuotaUsage }; if (response.ok && body.usage) setUserUsage(body.usage) })
      .catch(error => { if (error instanceof Error && error.name !== "AbortError") console.error("access_policy.user_usage_failed", error) })
    return () => controller.abort()
  }, [direction, selectedUserId, usageRevision])

  const updateRolePolicy = (patch: Partial<RolePolicy>) => setPolicies(previous => previous ? { ...previous, roles: { ...previous.roles, [role]: { ...previous.roles[role], ...patch } } } : previous)

  const saveRoles = async () => {
    if (!policies) return
    setSaving(true); setError("")
    try {
      const response = await fetch("/api/access-policies", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roles: policies.roles }) })
      const body = await response.clone().json() as { policies?: AccessPolicies }
      if (!response.ok || !body.policies) throw new LocalizedUiError(tApi(await readApiErrorCode(response, "ACCESS_POLICIES_SAVE_FAILED") as never))
      setPolicies(body.policies); setUsageRevision(value => value + 1); toast({ title: t("success.savePolicies") })
    } catch (caught) { setError(localizedUiErrorMessage(caught, t("errors.savePolicies"))) } finally { setSaving(false) }
  }

  const selectUser = (id: string) => { setSelectedUserId(id); setOverride(copyOverride(users.find(user => user.id === id)?.accessOverride)) }
  const saveUserOverride = async () => {
    if (!selectedUser) return
    setSaving(true); setError("")
    try {
      const response = await fetch(`/api/access-policies/users/${encodeURIComponent(selectedUser.id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(override) })
      const body = await response.clone().json() as { override?: UserOverride }
      if (!response.ok || !body.override) throw new LocalizedUiError(tApi(await readApiErrorCode(response, "USER_ACCESS_OVERRIDE_SAVE_FAILED") as never))
      setOverride(copyOverride(body.override)); setUsers(previous => previous.map(user => user.id === selectedUser.id ? { ...user, accessOverride: body.override! } : user)); setUsageRevision(value => value + 1); toast({ title: t("success.saveUser") })
    } catch (caught) { setError(localizedUiErrorMessage(caught, t("errors.saveUser"))) } finally { setSaving(false) }
  }

  const resetUserOverride = async () => {
    if (!selectedUser) return
    setSaving(true); setError("")
    try {
      const response = await fetch(`/api/access-policies/users/${encodeURIComponent(selectedUser.id)}`, { method: "DELETE" })
      if (!response.ok) throw new LocalizedUiError(tApi(await readApiErrorCode(response, "USER_ACCESS_OVERRIDE_RESET_FAILED") as never))
      setOverride(emptyOverride()); setUsers(previous => previous.map(user => user.id === selectedUser.id ? { ...user, accessOverride: null } : user)); setUsageRevision(value => value + 1); toast({ title: t("success.resetUser") })
    } catch (caught) { setError(localizedUiErrorMessage(caught, t("errors.resetUser"))) } finally { setSaving(false) }
  }

  const resetUsage = async (target: { role?: Role; userId?: string }) => {
    const response = await fetch("/api/access-policies/usage", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...target, direction }) })
    if (!response.ok) { setError(tApi(await readApiErrorCode(response, "MAIL_QUOTA_RESET_FAILED") as never)); return }
    setUsageRevision(value => value + 1); toast({ title: t("success.resetUsage") })
  }

  const resetMailboxUsage = async (
    target: { role?: Role; userId?: string },
    mailboxAddress: string,
  ) => {
    const response = await fetch("/api/access-policies/usage", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...target, direction, mailboxAddress }),
    })
    if (!response.ok) {
      setError(tApi(await readApiErrorCode(response, "MAIL_QUOTA_RESET_FAILED") as never))
      return
    }
    setUsageRevision(value => value + 1)
    toast({ title: t("success.resetMailboxUsage") })
  }

  const createBlock = async () => {
    if (!normalizedBlockLocalPart || !blockDomain || (blockScope === "user" && !blockUserId)) return
    const response = await fetch("/api/access-policies/mailbox-blocks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope: blockScope, userId: blockScope === "user" ? blockUserId : undefined, localPart: normalizedBlockLocalPart, domain: blockDomain }) })
    if (!response.ok) { setError(tApi(await readApiErrorCode(response, "MAILBOX_BLOCK_CREATE_FAILED") as never)); return }
    setBlockLocalPart(""); await loadBlocks(); toast({ title: t("success.createBlock") })
  }

  const deleteBlock = async (id: string) => {
    const response = await fetch(`/api/access-policies/mailbox-blocks?id=${encodeURIComponent(id)}`, { method: "DELETE" })
    if (!response.ok) { setError(tApi(await readApiErrorCode(response, "MAILBOX_BLOCK_DELETE_FAILED") as never)); return }
    setBlocks(previous => previous.filter(block => block.id !== id)); toast({ title: t("success.deleteBlock") })
  }

  const setUserDomainMode = (mode: "inherit" | "custom") => setOverride(previous => {
    const next = { ...previous }
    if (mode === "inherit") delete next.domainAccess
    else next.domainAccess = structuredClone(policies!.roles[selectedUserRole].domainAccess)
    return next
  })

  if (loading || !policies || !defaults || !rolePolicy) return <div className="flex min-h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>

  const userDomainMode = override.domainAccess ? "custom" : "inherit"
  const userDomainValue = (domain: string): DomainAccessMode => (
    override.domainAccess?.domains?.[domain]
      ?? override.domainAccess?.default
      ?? policies.roles[selectedUserRole].domainAccess.domains[domain]
      ?? policies.roles[selectedUserRole].domainAccess.default
  )
  const roleQuota = direction === "send" ? rolePolicy.sendQuota : rolePolicy.receiveQuota
  const inheritedUserQuota = direction === "send" ? policies.roles[selectedUserRole].sendQuota : policies.roles[selectedUserRole].receiveQuota
  const userQuotaOverride = direction === "send" ? override.sendQuota : override.receiveQuota

  return (
    <div className="rounded-lg border-2 border-primary/20 bg-background p-4 sm:p-5">
      <div className="mb-4 flex items-start gap-2"><ShieldCheck className="mt-0.5 h-5 w-5 text-primary" /><div><h2 className="font-semibold">{t("title")}</h2><p className="text-xs text-muted-foreground">{t("description")}</p></div></div>
      {error && <div className="mb-4 rounded border border-destructive/60 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
      <Tabs defaultValue="roles">
        <TabsList className="w-full justify-start overflow-x-auto"><TabsTrigger value="roles">{t("tabs.roles")}</TabsTrigger><TabsTrigger value="users">{t("tabs.users")}</TabsTrigger><TabsTrigger value="blocks">{t("tabs.blocks")}</TabsTrigger></TabsList>
        <TabsContent value="roles" className="space-y-4 pt-2">
          <div className="flex flex-wrap items-center justify-between gap-2"><Select value={role} onValueChange={value => setRole(value as Role)}><SelectTrigger className="w-44"><SelectValue /></SelectTrigger><SelectContent>{roles.map(item => <SelectItem key={item} value={item}>{tRoles(roleTranslationKeys[item])}</SelectItem>)}</SelectContent></Select><div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => setPolicies(previous => previous ? { ...previous, roles: { ...previous.roles, [role]: structuredClone(defaults.roles[role]) } } : previous)}><RotateCcw className="mr-1 h-4 w-4" />{t("actions.resetRole")}</Button><Button size="sm" onClick={() => void saveRoles()} disabled={saving}><Save className="mr-1 h-4 w-4" />{t("actions.save")}</Button></div></div>
          {emperorRole && <div className="rounded border border-amber-500/50 bg-amber-500/10 p-3 text-xs text-muted-foreground"><span className="flex items-center gap-2 font-medium text-foreground"><Crown className="h-4 w-4 text-amber-500" />{t("emperorLocked")}</span><p className="mt-1">{t("emperorQuotaEditableHint")}</p></div>}
          <div className="grid gap-4 xl:grid-cols-2">
            {!emperorRole && <><section className="rounded border p-4"><h3 className="mb-3 text-sm font-medium">{t("sections.permissions")}</h3><div className="grid gap-2 sm:grid-cols-2">{permissions.map(permission => <label key={permission} className="flex cursor-pointer items-center gap-2 rounded border p-2 text-sm"><Checkbox checked={rolePolicy.permissions[permission]} onChange={checked => updateRolePolicy({ permissions: { ...rolePolicy.permissions, [permission]: checked } })} /><span>{t(`permissions.${permission}` as never)}</span></label>)}</div></section><section className="rounded border p-4"><h3 className="mb-3 text-sm font-medium">{t("sections.quotas")}</h3><div className="grid gap-3 sm:grid-cols-2">{quotaKeys.map(key => <div key={key} className="space-y-1"><Label>{t(`quotas.${key}.label` as never)}</Label><Input type="number" min={0} max={key === "maxMessageBytes" ? 25 * 1024 * 1024 : undefined} value={rolePolicy.quotas[key]} onChange={event => updateRolePolicy({ quotas: { ...rolePolicy.quotas, [key]: Number(event.target.value) } })} /><p className="text-xs text-muted-foreground">{t(`quotas.${key}.help` as never)}</p></div>)}</div></section><section className="space-y-3 rounded border p-4 xl:col-span-2"><div><h3 className="flex items-center gap-2 text-sm font-medium"><Globe2 className="h-4 w-4 text-primary" />{t("sections.domains")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("domains.roleHelp")}</p></div><div className="grid gap-2 rounded border p-2 min-[420px]:grid-cols-[minmax(0,1fr)_auto] min-[420px]:items-center"><span className="text-sm">{t("domains.default")}</span><DomainModeSelect value={rolePolicy.domainAccess.default} onChange={defaultMode => updateRolePolicy({ domainAccess: { ...rolePolicy.domainAccess, default: defaultMode } })} label={t("domains.default")} /></div><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{domains.map(domain => <div key={domain} className="grid gap-2 rounded border p-2 min-[420px]:grid-cols-[minmax(0,1fr)_auto] min-[420px]:items-center"><span className="min-w-0 truncate font-mono text-xs">{domain}</span><DomainModeSelect value={rolePolicy.domainAccess.domains[domain] ?? rolePolicy.domainAccess.default} onChange={mode => updateRolePolicy({ domainAccess: { ...rolePolicy.domainAccess, domains: { ...rolePolicy.domainAccess.domains, [domain]: mode } } })} label={domain} /></div>)}</div></section></>}
            <div className="xl:col-span-2"><Tabs value={direction} onValueChange={value => setDirection(value as MailDirection)}><TabsList><TabsTrigger value="send">{t("directions.send")}</TabsTrigger><TabsTrigger value="receive">{t("directions.receive")}</TabsTrigger></TabsList></Tabs></div>
            <RoleMailQuotaEditor direction={direction} role={role} domains={domains} quota={roleQuota} usage={roleUsage} onReset={() => void resetUsage({ role })} onResetMailbox={address => void resetMailboxUsage({ role }, address)} onChange={quota => updateRolePolicy(direction === "send" ? { sendQuota: quota } : { receiveQuota: quota })} />
          </div>
        </TabsContent>
        <TabsContent value="users" className="space-y-4 pt-2">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(15rem,.8fr)]"><div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={search} onChange={event => setSearch(event.target.value)} placeholder={t("searchPlaceholder")} className="pl-9" /></div><Select value={selectedUserId} onValueChange={selectUser}><SelectTrigger><SelectValue placeholder={t("selectUser")} /></SelectTrigger><SelectContent>{users.map(user => <SelectItem key={user.id} value={user.id}>{tFormat("identityRole", { identity: user.name || user.username || user.email || user.id, role: tRoles(roleTranslationKeys[roleForUser(user)]) })}</SelectItem>)}</SelectContent></Select></div>
          {!selectedUser ? <div className="rounded border border-dashed p-8 text-center text-sm text-muted-foreground"><UserCog className="mx-auto mb-2 h-6 w-6" />{t("selectUserHint")}</div> : <div className="space-y-4"><p className="text-xs text-muted-foreground">{selectedUserIsEmperor ? t("emperorQuotaEditableHint") : t("overrideHint")}</p><div className="grid gap-4 xl:grid-cols-2">{!selectedUserIsEmperor && <><section className="rounded border p-4"><h3 className="mb-3 text-sm font-medium">{t("sections.permissionOverrides")}</h3><div className="space-y-2">{permissions.map(permission => <div key={permission} className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-2"><span className="text-sm">{t(`permissions.${permission}` as never)}</span><Select value={override.permissions[permission] === undefined ? "inherit" : override.permissions[permission] ? "allow" : "deny"} onValueChange={value => setOverride(previous => { const next = { ...previous, permissions: { ...previous.permissions } }; if (value === "inherit") delete next.permissions[permission]; else next.permissions[permission] = value === "allow"; return next })}><SelectTrigger className="h-8"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="inherit">{t("inherit")}</SelectItem><SelectItem value="allow">{t("allow")}</SelectItem><SelectItem value="deny">{t("deny")}</SelectItem></SelectContent></Select></div>)}</div></section><section className="rounded border p-4"><h3 className="mb-3 text-sm font-medium">{t("sections.quotaOverrides")}</h3><div className="space-y-3">{quotaKeys.map(key => { const enabled = override.quotas[key] !== undefined; return <div key={key} className="grid grid-cols-[auto_minmax(0,1fr)_7rem] items-center gap-2"><Checkbox checked={enabled} onChange={checked => setOverride(previous => { const quotas = { ...previous.quotas }; if (checked) quotas[key] = policies.roles[selectedUserRole].quotas[key]; else delete quotas[key]; return { ...previous, quotas } })} /><span className="text-sm">{t(`quotas.${key}.label` as never)}</span><Input className="h-8" type="number" disabled={!enabled} min={0} value={override.quotas[key] ?? ""} onChange={event => setOverride(previous => ({ ...previous, quotas: { ...previous.quotas, [key]: Number(event.target.value) } }))} /></div> })}</div></section><section className="space-y-3 rounded border p-4 xl:col-span-2"><div><h3 className="flex items-center gap-2 text-sm font-medium"><Globe2 className="h-4 w-4 text-primary" />{t("sections.domainOverrides")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("domains.userHelp")}</p></div><Select value={userDomainMode} onValueChange={value => setUserDomainMode(value as "inherit" | "custom")}><SelectTrigger className="w-full sm:w-64"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="inherit">{t("domains.inherit")}</SelectItem><SelectItem value="custom">{t("domains.custom")}</SelectItem></SelectContent></Select>{override.domainAccess && <><div className="flex items-center justify-between gap-3 rounded border p-2"><span className="text-sm">{t("domains.default")}</span><DomainModeSelect value={override.domainAccess.default ?? policies.roles[selectedUserRole].domainAccess.default} onChange={defaultMode => setOverride(previous => ({ ...previous, domainAccess: { ...previous.domainAccess, default: defaultMode } }))} /></div><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{domains.map(domain => <div key={domain} className="flex items-center justify-between gap-3 rounded border p-2"><span className="min-w-0 truncate font-mono text-xs">{domain}</span><DomainModeSelect value={userDomainValue(domain)} onChange={mode => setOverride(previous => ({ ...previous, domainAccess: { ...previous.domainAccess, domains: { ...previous.domainAccess?.domains, [domain]: mode } } }))} /></div>)}</div></>}</section></>}<div className="xl:col-span-2"><Tabs value={direction} onValueChange={value => setDirection(value as MailDirection)}><TabsList><TabsTrigger value="send">{t("directions.send")}</TabsTrigger><TabsTrigger value="receive">{t("directions.receive")}</TabsTrigger></TabsList></Tabs></div><UserMailQuotaEditor direction={direction} userId={selectedUser.id} domains={domains} inherited={inheritedUserQuota} override={userQuotaOverride} usage={userUsage} onReset={() => void resetUsage({ userId: selectedUser.id })} onResetMailbox={address => void resetMailboxUsage({ userId: selectedUser.id }, address)} onChange={quota => setOverride(previous => { const next = { ...previous }; if (direction === "send") { if (quota) next.sendQuota = quota; else delete next.sendQuota } else { if (quota) next.receiveQuota = quota; else delete next.receiveQuota } return next })} /></div><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => void resetUserOverride()} disabled={saving}><RotateCcw className="mr-1 h-4 w-4" />{t("actions.inheritAll")}</Button><Button onClick={() => void saveUserOverride()} disabled={saving}><Save className="mr-1 h-4 w-4" />{t("actions.saveUser")}</Button></div></div>}
        </TabsContent>
        <TabsContent value="blocks" className="space-y-4 pt-2"><div><h3 className="text-sm font-medium">{t("blocks.title")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("blocks.help")}</p></div><div className="space-y-2 rounded border p-3"><div className="grid gap-2 sm:grid-cols-[minmax(7rem,1fr)_minmax(8rem,1fr)_8rem_minmax(10rem,1fr)_auto]"><Input className="h-8" value={blockLocalPart} onChange={event => setBlockLocalPart(event.target.value.split("@", 1)[0].slice(0, 64))} placeholder={t("blocks.localPart")} maxLength={64} pattern="[A-Za-z0-9._+-]+" autoCapitalize="none" autoComplete="off" spellCheck={false} /><Select value={blockDomain} onValueChange={setBlockDomain}><SelectTrigger className="h-8"><SelectValue placeholder={t("blocks.domain")} /></SelectTrigger><SelectContent>{domains.map(domain => <SelectItem key={domain} value={domain}>{domain}</SelectItem>)}</SelectContent></Select><Select value={blockScope} onValueChange={value => setBlockScope(value as "global" | "user")}><SelectTrigger className="h-8"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="global">{t("blocks.global")}</SelectItem><SelectItem value="user">{t("blocks.user")}</SelectItem></SelectContent></Select><Select value={blockUserId} onValueChange={setBlockUserId} disabled={blockScope === "global"}><SelectTrigger className="h-8"><SelectValue placeholder={t("blocks.selectUser")} /></SelectTrigger><SelectContent>{users.map(user => <SelectItem key={user.id} value={user.id}>{user.name || user.username || user.email || user.id}</SelectItem>)}</SelectContent></Select><Button type="button" size="sm" className="h-8" disabled={!normalizedBlockLocalPart || !blockDomain || (blockScope === "user" && !blockUserId)} onClick={() => void createBlock()}>{t("blocks.add")}</Button></div>{invalidBlockLocalPart && <p className="text-xs text-destructive">{t("blocks.invalidLocalPart")}</p>}</div>{blocks.length === 0 ? <div className="rounded border border-dashed p-6 text-center text-sm text-muted-foreground">{t("blocks.empty")}</div> : <div className="grid gap-2 sm:grid-cols-2">{blocks.map(block => <div key={block.id} className="flex items-center justify-between gap-3 rounded border p-3"><div className="min-w-0"><div className="truncate font-mono text-sm">{block.localPart}@{block.domain}</div><div className="truncate text-xs text-muted-foreground">{block.userId ? t("blocks.userScope", { user: block.user?.name || block.user?.username || block.user?.email || block.userId }) : t("blocks.globalScope")}</div></div><AlertDialog><AlertDialogTrigger asChild><Button type="button" variant="ghost" size="icon" className="shrink-0 text-destructive"><Trash2 className="h-4 w-4" /></Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t("blocks.deleteTitle")}</AlertDialogTitle><AlertDialogDescription>{t("blocks.deleteDescription", { address: `${block.localPart}@${block.domain}` })}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{t("blocks.cancel")}</AlertDialogCancel><AlertDialogAction onClick={() => void deleteBlock(block.id)}>{t("blocks.delete")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></div>)}</div>}</TabsContent>
      </Tabs>
    </div>
  )
}
