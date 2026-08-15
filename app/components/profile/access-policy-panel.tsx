"use client"

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, Crown, Globe2, Info, Loader2, Pencil, RotateCcw, Save, Search, ShieldCheck, Trash2, UserCog, X } from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"
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
  MailQuotaRuleEditor,
  MailQuotaUsageManager,
  type MailQuotaAssignment,
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
import { normalizeMailboxBlockCreationName } from "@/lib/email-address"
import {
  ALL_MAILBOX_BLOCK_DOMAINS,
  ALL_MAILBOX_BLOCK_LOCAL_PARTS,
} from "@/lib/mailbox-block-scope"
import { SearchableUserSelect, type SearchableUser } from "@/components/profile/searchable-user-select"

const quotaKeys = ["maxActiveMailboxes", "maxMailboxLifetimeDays", "maxMessageBytes"] as const
type QuotaKey = typeof quotaKeys[number]
const quotaMaximums: Record<QuotaKey, number> = {
  maxActiveMailboxes: 100_000,
  maxMailboxLifetimeDays: 36_500,
  maxMessageBytes: 25 * 1024 * 1024,
}
type DomainAccessMode = "allow" | "receive" | "send" | "deny"
type DomainAccessPolicy = { default: DomainAccessMode; domains: Record<string, DomainAccessMode> }
type DomainAccessOverride = { default?: DomainAccessMode; domains?: Record<string, DomainAccessMode> }
type RolePolicy = {
  permissions: Record<Permission, boolean>
  quotas: Record<QuotaKey, number>
  domainAccess: DomainAccessPolicy
}
type UserOverride = {
  permissions: Partial<Record<Permission, boolean>>
  quotas: Partial<Record<QuotaKey, number>>
  domainAccess?: DomainAccessOverride
}
interface AccessPolicies { version: 7; roles: Record<Role, RolePolicy>; users: Record<string, UserOverride>; mailQuotaRules: MailQuotaAssignment[] }
interface UserItem { id: string; name: string | null; username: string | null; email: string | null; role: string | null; accessOverride: UserOverride | null }
interface MailboxBlock {
  id: string
  userId: string | null
  scopeKey: string
  localPart: string
  domain: string
  user?: { id: string; name: string | null; username: string | null; email: string | null } | null
  allowedRoles?: Role[] | null
}

const roles = [ROLES.EMPEROR, ROLES.DUKE, ROLES.KNIGHT, ROLES.CIVILIAN] as const
const domainModes: DomainAccessMode[] = ["allow", "receive", "send", "deny"]
const roleTranslationKeys = { emperor: "EMPEROR", duke: "DUKE", knight: "KNIGHT", civilian: "CIVILIAN" } as const
const emptyOverride = (): UserOverride => ({ permissions: {}, quotas: {} })
const mailboxBlockPageSize = 12
const allMailboxBlockScopes = "all"
const allMailboxBlockDomains = "__all_domains__"

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

function GeneralQuotaFields({ values, inherited, onChange }: {
  values: Partial<Record<QuotaKey, number>>
  inherited?: Record<QuotaKey, number>
  onChange: (key: QuotaKey, value: number | undefined) => void
}) {
  const t = useTranslations("admin.access")
  const overrideMode = inherited !== undefined

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {quotaKeys.map(key => {
        const enabled = !overrideMode || values[key] !== undefined
        const fieldId = `${overrideMode ? "user" : "role"}-quota-${key}`
        return (
          <div key={key} className="space-y-1.5 rounded-md border p-3">
            <div className="flex items-start gap-2">
              {overrideMode && (
                <Checkbox
                  checked={enabled}
                  onChange={checked => onChange(key, checked ? inherited[key] : undefined)}
                  aria-label={t("quotas.overrideField", { field: t(`quotas.${key}.label` as never) })}
                />
              )}
              <Label htmlFor={fieldId} className="leading-5">{t(`quotas.${key}.label` as never)}</Label>
            </div>
            <Input
              id={fieldId}
              type="number"
              disabled={!enabled}
              min={0}
              max={quotaMaximums[key]}
              value={values[key] ?? ""}
              onChange={event => onChange(key, Number(event.target.value))}
            />
            <p className="text-xs leading-relaxed text-muted-foreground">{t(`quotas.${key}.help` as never)}</p>
            {overrideMode && !enabled && (
              <p className="text-xs text-muted-foreground">
                {t("quotas.inheritedValue", { value: inherited[key] })}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function AccessPolicyPanel() {
  const formatList = useFormatter()
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
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [users, setUsers] = useState<UserItem[]>([])
  const [search, setSearch] = useState("")
  const [selectedUserId, setSelectedUserId] = useState("")
  const [override, setOverride] = useState<UserOverride>(emptyOverride)
  const [usageRevision, setUsageRevision] = useState(0)
  const [blocks, setBlocks] = useState<MailboxBlock[]>([])
  const [blockLocalPart, setBlockLocalPart] = useState("")
  const [blockDomain, setBlockDomain] = useState("")
  const [blockScope, setBlockScope] = useState<"global" | "user" | "roles">("global")
  const [blockUserId, setBlockUserId] = useState("")
  const [blockAllowedRoles, setBlockAllowedRoles] = useState<Role[]>([])
  const [blockSearch, setBlockSearch] = useState("")
  const [blockScopeFilter, setBlockScopeFilter] = useState<"all" | "global" | "user" | "roles">("all")
  const [blockDomainFilter, setBlockDomainFilter] = useState(allMailboxBlockDomains)
  const [blockPage, setBlockPage] = useState(1)
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null)
  const [savingBlock, setSavingBlock] = useState(false)
  const [deletingBlockId, setDeletingBlockId] = useState<string | null>(null)
  const blockFormRef = useRef<HTMLDivElement>(null)
  const deferredBlockSearch = useDeferredValue(blockSearch)
  const normalizedBlockLocalPart = normalizeMailboxBlockCreationName(blockLocalPart)
  const invalidBlockLocalPart = blockLocalPart.length > 0 && !normalizedBlockLocalPart
  const indexedBlocks = useMemo(() => blocks.map(block => {
      const identity = block.user?.name || block.user?.username || block.user?.email || block.userId || ""
      const domainLabel = block.domain === ALL_MAILBOX_BLOCK_DOMAINS ? t("blocks.allDomains") : block.domain
      const localizedRoles = block.allowedRoles?.map(item => tRoles(roleTranslationKeys[item])).join(" ") ?? ""
      return {
        block,
        scope: block.allowedRoles ? "roles" as const : block.userId ? "user" as const : "global" as const,
        searchText: `${block.localPart}@${block.domain} ${domainLabel} ${identity} ${block.allowedRoles?.join(" ") ?? ""} ${localizedRoles}`
          .normalize("NFKC").toLocaleLowerCase(),
      }
    }), [blocks, t, tRoles])
  const filteredBlocks = useMemo(() => {
    const query = deferredBlockSearch.trim().normalize("NFKC").toLocaleLowerCase()
    return indexedBlocks.filter(item => (
      (!query || item.searchText.includes(query))
      && (blockScopeFilter === allMailboxBlockScopes || item.scope === blockScopeFilter)
      && (blockDomainFilter === allMailboxBlockDomains || item.block.domain === blockDomainFilter)
    )).map(item => item.block)
  }, [blockDomainFilter, blockScopeFilter, deferredBlockSearch, indexedBlocks])
  const blockPageCount = Math.max(1, Math.ceil(filteredBlocks.length / mailboxBlockPageSize))
  const currentBlockPage = Math.min(blockPage, blockPageCount)
  const pagedBlocks = useMemo(() => {
    const start = (currentBlockPage - 1) * mailboxBlockPageSize
    return filteredBlocks.slice(start, start + mailboxBlockPageSize)
  }, [currentBlockPage, filteredBlocks])
  const blockKnownUsers = useMemo(() => {
    const byId = new Map<string, SearchableUser>(users.map(user => [user.id, user]))
    for (const block of blocks) {
      if (block.user && !byId.has(block.user.id)) {
        byId.set(block.user.id, { ...block.user, role: null })
      }
    }
    return [...byId.values()]
  }, [blocks, users])
  const blockFilterDomains = useMemo(() => [...new Set([
    ALL_MAILBOX_BLOCK_DOMAINS,
    ...domains,
    ...blocks.map(block => block.domain),
  ])], [blocks, domains])

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

  const loadUsers = useCallback(async (signal?: AbortSignal) => {
    try {
      const params = new URLSearchParams({ page: "1", pageSize: "100" })
      if (search.trim()) params.set("search", search.trim())
      const response = await fetch(`/api/roles/users?${params}`, { cache: "no-store", signal })
      const body = await response.clone().json() as { users?: UserItem[] }
      if (!response.ok || !body.users) throw new LocalizedUiError(tApi(await readApiErrorCode(response, "USERS_READ_FAILED") as never))
      setUsers(body.users)
    } catch (caught) {
      if (caught instanceof Error && caught.name === "AbortError") return
      setError(localizedUiErrorMessage(caught, t("errors.loadUsers")))
    }
  }, [search, t, tApi])

  const rememberUser = useCallback((user: SearchableUser) => {
    const resolved = {
      ...user,
      accessOverride: (user.accessOverride ?? null) as UserOverride | null,
    }
    setUsers(previous => previous.some(item => item.id === user.id)
      ? previous.map(item => item.id === user.id ? { ...item, ...resolved } : item)
      : [...previous, resolved])
  }, [])

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
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => void loadUsers(controller.signal), 200)
    return () => { clearTimeout(timer); controller.abort() }
  }, [loadUsers])
  useEffect(() => { setBlockPage(1) }, [blockDomainFilter, blockScopeFilter, deferredBlockSearch])
  useEffect(() => {
    if (blockPage > blockPageCount) setBlockPage(blockPageCount)
  }, [blockPage, blockPageCount])
  useEffect(() => {
    if (blockDomainFilter !== allMailboxBlockDomains && !blockFilterDomains.includes(blockDomainFilter)) {
      setBlockDomainFilter(allMailboxBlockDomains)
    }
  }, [blockDomainFilter, blockFilterDomains])

  const selectedUser = useMemo(() => users.find(user => user.id === selectedUserId) ?? null, [selectedUserId, users])
  const selectedUserRole = roleForUser(selectedUser)
  const rolePolicy = policies?.roles[role]
  const emperorRole = role === ROLES.EMPEROR
  const selectedUserIsEmperor = selectedUserRole === ROLES.EMPEROR

  const updateRolePolicy = (patch: Partial<RolePolicy>) => setPolicies(previous => previous ? { ...previous, roles: { ...previous.roles, [role]: { ...previous.roles[role], ...patch } } } : previous)

  const saveRoles = async () => {
    if (!policies) return
    setSaving(true); setError("")
    try {
      const response = await fetch("/api/access-policies", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roles: policies.roles, mailQuotaRules: policies.mailQuotaRules }) })
      const body = await response.clone().json() as { policies?: AccessPolicies }
      if (!response.ok || !body.policies) throw new LocalizedUiError(tApi(await readApiErrorCode(response, "ACCESS_POLICIES_SAVE_FAILED") as never))
      setPolicies(body.policies)
      setUsageRevision(value => value + 1)
      toast({ title: t("success.savePolicies") })
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

  const resetBlockDraft = () => {
    setEditingBlockId(null)
    setBlockLocalPart("")
    setBlockScope("global")
    setBlockUserId("")
    setBlockAllowedRoles([])
  }

  const editBlock = (block: MailboxBlock) => {
    setEditingBlockId(block.id)
    setBlockLocalPart(block.localPart)
    setBlockDomain(block.domain)
    if (block.allowedRoles) {
      setBlockScope("roles")
      setBlockAllowedRoles(block.allowedRoles)
      setBlockUserId("")
    } else if (block.userId) {
      setBlockScope("user")
      setBlockUserId(block.userId)
      setBlockAllowedRoles([])
    } else {
      setBlockScope("global")
      setBlockUserId("")
      setBlockAllowedRoles([])
    }
    requestAnimationFrame(() => blockFormRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }))
  }

  const saveBlock = async () => {
    if (!normalizedBlockLocalPart || !blockDomain || (blockScope === "user" && !blockUserId)) return
    const updating = editingBlockId !== null
    setSavingBlock(true)
    setError("")
    try {
      const endpoint = updating
        ? `/api/access-policies/mailbox-blocks?id=${encodeURIComponent(editingBlockId!)}`
        : "/api/access-policies/mailbox-blocks"
      const response = await fetch(endpoint, { method: updating ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope: blockScope, userId: blockScope === "user" ? blockUserId : undefined, allowedRoles: blockScope === "roles" ? blockAllowedRoles : undefined, localPart: normalizedBlockLocalPart, domain: blockDomain }) })
      if (!response.ok) throw new LocalizedUiError(tApi(await readApiErrorCode(response, updating ? "MAILBOX_BLOCK_UPDATE_FAILED" : "MAILBOX_BLOCK_CREATE_FAILED") as never))
      await loadBlocks()
      if (updating) resetBlockDraft()
      else setBlockLocalPart("")
      toast({ title: t(updating ? "success.updateBlock" : "success.createBlock") })
    } catch (caught) {
      setError(localizedUiErrorMessage(caught, t(updating ? "errors.updateBlock" : "errors.createBlock")))
    } finally {
      setSavingBlock(false)
    }
  }

  const deleteBlock = async (id: string) => {
    setDeletingBlockId(id)
    setError("")
    try {
      const response = await fetch(`/api/access-policies/mailbox-blocks?id=${encodeURIComponent(id)}`, { method: "DELETE" })
      if (!response.ok) throw new LocalizedUiError(tApi(await readApiErrorCode(response, "MAILBOX_BLOCK_DELETE_FAILED") as never))
      setBlocks(previous => previous.filter(block => block.id !== id))
      if (editingBlockId === id) resetBlockDraft()
      toast({ title: t("success.deleteBlock") })
    } catch (caught) {
      setError(localizedUiErrorMessage(caught, t("errors.deleteBlock")))
    } finally {
      setDeletingBlockId(null)
    }
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
  const blockAddress = (block: Pick<MailboxBlock, "localPart" | "domain">) => (
    block.domain === ALL_MAILBOX_BLOCK_DOMAINS
      ? t("blocks.allDomainsAddress", { localPart: block.localPart })
      : `${block.localPart}@${block.domain}`
  )
  const blockScopeDescription = (block: MailboxBlock) => block.allowedRoles
    ? t("blocks.rolesScope", { roles: block.allowedRoles.length ? formatList.list(block.allowedRoles.map(item => tRoles(roleTranslationKeys[item])), { type: "unit" }) : t("blocks.emperorOnly") })
    : block.userId
      ? t("blocks.userScope", { user: block.user?.name || block.user?.username || block.user?.email || block.userId })
      : t("blocks.globalScope")
  const blockRangeStart = filteredBlocks.length === 0
    ? 0
    : (currentBlockPage - 1) * mailboxBlockPageSize + 1
  const blockRangeEnd = Math.min(currentBlockPage * mailboxBlockPageSize, filteredBlocks.length)
  const blockFiltersActive = blockSearch.length > 0
    || blockScopeFilter !== allMailboxBlockScopes
    || blockDomainFilter !== allMailboxBlockDomains
  return (
    <div className="min-w-0 rounded-lg border-2 border-primary/20 bg-background p-4 sm:p-5">
      <div className="mb-4 flex min-w-0 items-start gap-2"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" /><div className="min-w-0"><h2 className="font-semibold">{t("title")}</h2><p className="text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{t("description")}</p></div></div>
      {error && <div className="mb-4 rounded border border-destructive/60 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
      <div className="mb-4 rounded-md border border-primary/20 bg-primary/5 p-3">
        <h3 className="flex items-center gap-2 text-sm font-medium"><Info className="h-4 w-4 text-primary" />{t("quotaGuide.title")}</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-relaxed text-muted-foreground">
          <li>{t("quotaGuide.general")}</li>
          <li>{t("quotaGuide.mail")}</li>
          <li>{t("quotaGuide.enforcement")}</li>
        </ul>
      </div>
      <Tabs defaultValue="roles" className="min-w-0">
        <TabsList className="h-auto w-full max-w-full justify-start overflow-x-auto"><TabsTrigger className="shrink-0" value="roles">{t("tabs.roles")}</TabsTrigger><TabsTrigger className="shrink-0" value="users">{t("tabs.users")}</TabsTrigger><TabsTrigger className="shrink-0" value="mailQuotas">{t("tabs.mailQuotas")}</TabsTrigger><TabsTrigger className="shrink-0" value="blocks">{t("tabs.blocks")}</TabsTrigger></TabsList>
        <TabsContent value="roles" className="space-y-4 pt-2">
          <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"><Select value={role} onValueChange={value => setRole(value as Role)}><SelectTrigger className="min-w-0 gap-2 sm:w-44 [&>span]:min-w-0 [&>span]:truncate [&>svg]:shrink-0"><SelectValue /></SelectTrigger><SelectContent>{roles.map(item => <SelectItem key={item} value={item}>{tRoles(roleTranslationKeys[item])}</SelectItem>)}</SelectContent></Select><div className="grid grid-cols-2 gap-2 sm:flex"><Button className="min-h-8 h-auto whitespace-normal" variant="outline" size="sm" onClick={() => setPolicies(previous => previous ? { ...previous, roles: { ...previous.roles, [role]: structuredClone(defaults.roles[role]) } } : previous)}><RotateCcw className="mr-1 h-4 w-4 shrink-0" />{t("actions.resetRole")}</Button><Button className="min-h-8 h-auto whitespace-normal" size="sm" onClick={() => void saveRoles()} disabled={saving}><Save className="mr-1 h-4 w-4 shrink-0" />{t("actions.save")}</Button></div></div>
          {emperorRole && <div className="rounded border border-amber-500/50 bg-amber-500/10 p-3 text-xs text-muted-foreground"><span className="flex items-center gap-2 font-medium text-foreground"><Crown className="h-4 w-4 text-amber-500" />{t("emperorLocked")}</span><p className="mt-1">{t("emperorQuotaEditableHint")}</p></div>}
          <div className="grid gap-4 xl:grid-cols-2">
            {!emperorRole && <><section className="rounded border p-4"><h3 className="mb-3 text-sm font-medium">{t("sections.permissions")}</h3><div className="grid gap-2 sm:grid-cols-2">{permissions.map(permission => <label key={permission} className="flex cursor-pointer items-center gap-2 rounded border p-2 text-sm"><Checkbox checked={rolePolicy.permissions[permission]} onChange={checked => updateRolePolicy({ permissions: { ...rolePolicy.permissions, [permission]: checked } })} /><span>{t(`permissions.${permission}` as never)}</span></label>)}</div></section><section className="rounded border p-4"><h3 className="text-sm font-medium">{t("sections.quotas")}</h3><p className="mb-3 mt-1 text-xs leading-relaxed text-muted-foreground">{t("quotas.sectionHelp")}</p><GeneralQuotaFields values={rolePolicy.quotas} onChange={(key, value) => { if (value !== undefined) updateRolePolicy({ quotas: { ...rolePolicy.quotas, [key]: value } }) }} /></section><section className="space-y-3 rounded border p-4 xl:col-span-2"><div><h3 className="flex items-center gap-2 text-sm font-medium"><Globe2 className="h-4 w-4 text-primary" />{t("sections.domains")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("domains.roleHelp")}</p></div><div className="grid gap-2 rounded border p-2 min-[420px]:grid-cols-[minmax(0,1fr)_auto] min-[420px]:items-center"><span className="text-sm">{t("domains.default")}</span><DomainModeSelect value={rolePolicy.domainAccess.default} onChange={defaultMode => updateRolePolicy({ domainAccess: { ...rolePolicy.domainAccess, default: defaultMode } })} label={t("domains.default")} /></div><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{domains.map(domain => <div key={domain} className="grid gap-2 rounded border p-2 min-[420px]:grid-cols-[minmax(0,1fr)_auto] min-[420px]:items-center"><span className="min-w-0 truncate font-mono text-xs">{domain}</span><DomainModeSelect value={rolePolicy.domainAccess.domains[domain] ?? rolePolicy.domainAccess.default} onChange={mode => updateRolePolicy({ domainAccess: { ...rolePolicy.domainAccess, domains: { ...rolePolicy.domainAccess.domains, [domain]: mode } } })} label={domain} /></div>)}</div></section></>}
          </div>
        </TabsContent>
        <TabsContent value="users" className="space-y-4 pt-2">
          <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(15rem,.8fr)]"><div className="relative min-w-0"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={search} onChange={event => setSearch(event.target.value)} placeholder={t("searchPlaceholder")} className="min-w-0 pl-9" /></div><Select value={selectedUserId} onValueChange={selectUser}><SelectTrigger className="min-w-0 gap-2 [&>span]:min-w-0 [&>span]:truncate [&>svg]:shrink-0"><SelectValue placeholder={t("selectUser")} /></SelectTrigger><SelectContent>{users.map(user => <SelectItem key={user.id} value={user.id}>{tFormat("identityRole", { identity: user.name || user.username || user.email || user.id, role: tRoles(roleTranslationKeys[roleForUser(user)]) })}</SelectItem>)}</SelectContent></Select></div>
          {!selectedUser ? <div className="rounded border border-dashed p-8 text-center text-sm text-muted-foreground"><UserCog className="mx-auto mb-2 h-6 w-6" />{t("selectUserHint")}</div> : <div className="space-y-4"><p className="text-xs text-muted-foreground">{selectedUserIsEmperor ? t("emperorLockedHint") : t("overrideHint")}</p><div className="grid gap-4 xl:grid-cols-2">{!selectedUserIsEmperor && <><section className="rounded border p-4"><h3 className="mb-3 text-sm font-medium">{t("sections.permissionOverrides")}</h3><div className="space-y-2">{permissions.map(permission => <div key={permission} className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-2"><span className="text-sm">{t(`permissions.${permission}` as never)}</span><Select value={override.permissions[permission] === undefined ? "inherit" : override.permissions[permission] ? "allow" : "deny"} onValueChange={value => setOverride(previous => { const next = { ...previous, permissions: { ...previous.permissions } }; if (value === "inherit") delete next.permissions[permission]; else next.permissions[permission] = value === "allow"; return next })}><SelectTrigger className="h-8"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="inherit">{t("inherit")}</SelectItem><SelectItem value="allow">{t("allow")}</SelectItem><SelectItem value="deny">{t("deny")}</SelectItem></SelectContent></Select></div>)}</div></section><section className="rounded border p-4"><h3 className="text-sm font-medium">{t("sections.quotaOverrides")}</h3><p className="mb-3 mt-1 text-xs leading-relaxed text-muted-foreground">{t("quotas.overrideHelp")}</p><GeneralQuotaFields values={override.quotas} inherited={policies.roles[selectedUserRole].quotas} onChange={(key, value) => setOverride(previous => { const quotas = { ...previous.quotas }; if (value === undefined) delete quotas[key]; else quotas[key] = value; return { ...previous, quotas } })} /></section><section className="space-y-3 rounded border p-4 xl:col-span-2"><div><h3 className="flex items-center gap-2 text-sm font-medium"><Globe2 className="h-4 w-4 text-primary" />{t("sections.domainOverrides")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("domains.userHelp")}</p></div><Select value={userDomainMode} onValueChange={value => setUserDomainMode(value as "inherit" | "custom")}><SelectTrigger className="w-full sm:w-64"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="inherit">{t("domains.inherit")}</SelectItem><SelectItem value="custom">{t("domains.custom")}</SelectItem></SelectContent></Select>{override.domainAccess && <><div className="flex items-center justify-between gap-3 rounded border p-2"><span className="text-sm">{t("domains.default")}</span><DomainModeSelect value={override.domainAccess.default ?? policies.roles[selectedUserRole].domainAccess.default} onChange={defaultMode => setOverride(previous => ({ ...previous, domainAccess: { ...previous.domainAccess, default: defaultMode } }))} /></div><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{domains.map(domain => <div key={domain} className="flex items-center justify-between gap-3 rounded border p-2"><span className="min-w-0 truncate font-mono text-xs">{domain}</span><DomainModeSelect value={userDomainValue(domain)} onChange={mode => setOverride(previous => ({ ...previous, domainAccess: { ...previous.domainAccess, domains: { ...previous.domainAccess?.domains, [domain]: mode } } }))} /></div>)}</div></>}</section></>}</div><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => void resetUserOverride()} disabled={saving}><RotateCcw className="mr-1 h-4 w-4" />{t("actions.inheritAll")}</Button><Button onClick={() => void saveUserOverride()} disabled={saving}><Save className="mr-1 h-4 w-4" />{t("actions.saveUser")}</Button></div></div>}
        </TabsContent>
        <TabsContent value="mailQuotas" className="min-w-0 space-y-4 pt-2"><MailQuotaRuleEditor rules={policies.mailQuotaRules} domains={domains} users={users} onUserResolved={rememberUser} onChange={mailQuotaRules => setPolicies(previous => previous ? { ...previous, mailQuotaRules } : previous)} /><MailQuotaUsageManager users={users} revision={usageRevision} onUserResolved={rememberUser} onReset={() => { setUsageRevision(value => value + 1); toast({ title: t("success.resetUsage") }) }} /><div className="flex justify-end"><Button className="w-full sm:w-auto" onClick={() => void saveRoles()} disabled={saving}><Save className="mr-1 h-4 w-4 shrink-0" />{t("actions.save")}</Button></div></TabsContent>
        <TabsContent value="blocks" className="min-w-0 space-y-4 pt-2">
          <div>
            <h3 className="text-sm font-medium">{t("blocks.title")}</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("blocks.help")}</p>
          </div>

          <div ref={blockFormRef} className={`space-y-3 rounded-md border p-3 transition-colors ${editingBlockId ? "border-primary/50 bg-primary/[0.03]" : ""}`}>
            <div className="flex min-w-0 items-center justify-between gap-3">
              <div className="min-w-0">
                <h4 className="text-sm font-medium">{t(editingBlockId ? "blocks.editTitle" : "blocks.createTitle")}</h4>
                <p className="text-xs leading-relaxed text-muted-foreground">{t(editingBlockId ? "blocks.editHelp" : "blocks.createHelp")}</p>
              </div>
              {editingBlockId && <span className="shrink-0 rounded-full bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary">{t("blocks.editing")}</span>}
            </div>
            <div className="grid min-w-0 gap-2 lg:grid-cols-2 xl:grid-cols-[minmax(7rem,1fr)_minmax(8rem,1fr)_minmax(8rem,.8fr)_minmax(10rem,1.2fr)_auto]">
              <Input aria-label={t("blocks.localPart")} className="h-8 min-w-0" value={blockLocalPart} onChange={event => setBlockLocalPart(event.target.value.split("@", 1)[0].slice(0, 64))} placeholder={t("blocks.localPart")} maxLength={64} pattern="(?:\*|[A-Za-z0-9._+-]+)" autoCapitalize="none" autoComplete="off" spellCheck={false} />
              <Select value={blockDomain} onValueChange={setBlockDomain}><SelectTrigger aria-label={t("blocks.domain")} className="h-8 min-w-0 gap-2 [&>span]:min-w-0 [&>span]:truncate [&>svg]:shrink-0"><SelectValue placeholder={t("blocks.domain")} /></SelectTrigger><SelectContent><SelectItem value={ALL_MAILBOX_BLOCK_DOMAINS}>{t("blocks.allDomains")}</SelectItem>{domains.map(domain => <SelectItem key={domain} value={domain}>{domain}</SelectItem>)}</SelectContent></Select>
              <Select value={blockScope} onValueChange={value => setBlockScope(value as "global" | "user" | "roles")}><SelectTrigger aria-label={t("blocks.scope")} className="h-8 min-w-0 gap-2 [&>span]:min-w-0 [&>span]:truncate [&>svg]:shrink-0"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="global">{t("blocks.global")}</SelectItem><SelectItem value="user">{t("blocks.user")}</SelectItem><SelectItem value="roles">{t("blocks.roles")}</SelectItem></SelectContent></Select>
              {blockScope === "user" ? <SearchableUserSelect value={blockUserId} onValueChange={setBlockUserId} knownUsers={blockKnownUsers} onUserResolved={rememberUser} /> : <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded border px-2 py-1 text-xs">{blockScope === "roles" ? roles.filter(item => item !== ROLES.EMPEROR).map(item => <label key={item} className="flex items-center gap-1"><Checkbox checked={blockAllowedRoles.includes(item)} onChange={checked => setBlockAllowedRoles(previous => checked ? [...new Set([...previous, item])] : previous.filter(roleName => roleName !== item))} />{tRoles(roleTranslationKeys[item])}</label>) : <span className="min-w-0 leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{t("blocks.globalHint")}</span>}</div>}
              <div className="flex min-w-0 gap-2 lg:col-span-2 lg:justify-end xl:col-span-1">
                {editingBlockId && <Button type="button" size="sm" variant="outline" className="min-h-8 h-auto flex-1 whitespace-normal lg:flex-none" disabled={savingBlock} onClick={resetBlockDraft}><X className="mr-1 h-4 w-4 shrink-0" />{t("blocks.cancelEdit")}</Button>}
                <Button type="button" size="sm" className="min-h-8 h-auto flex-1 whitespace-normal lg:flex-none" disabled={savingBlock || !normalizedBlockLocalPart || !blockDomain || (blockScope === "user" && !blockUserId)} onClick={() => void saveBlock()}>{savingBlock && <Loader2 className="mr-1 h-4 w-4 shrink-0 animate-spin" />}{t(editingBlockId ? "blocks.update" : "blocks.add")}</Button>
              </div>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{t("blocks.wildcardHelp", { wildcard: ALL_MAILBOX_BLOCK_LOCAL_PARTS })}</p>
            {blockScope === "roles" && <p className="text-xs leading-relaxed text-muted-foreground">{t("blocks.rolesHelp")}</p>}
            {invalidBlockLocalPart && <p className="text-xs text-destructive">{t("blocks.invalidLocalPart")}</p>}
          </div>

          <div className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(14rem,1fr)_10rem_minmax(10rem,14rem)_auto]">
            <div className="relative min-w-0 sm:col-span-2 xl:col-span-1"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={blockSearch} onChange={event => setBlockSearch(event.target.value)} placeholder={t("blocks.search")} className="min-w-0 pl-9" /></div>
            <Select value={blockScopeFilter} onValueChange={value => setBlockScopeFilter(value as typeof blockScopeFilter)}><SelectTrigger aria-label={t("blocks.scopeFilter")} className="min-w-0 gap-2 [&>span]:min-w-0 [&>span]:truncate"><SelectValue /></SelectTrigger><SelectContent><SelectItem value={allMailboxBlockScopes}>{t("blocks.allScopes")}</SelectItem><SelectItem value="global">{t("blocks.global")}</SelectItem><SelectItem value="user">{t("blocks.user")}</SelectItem><SelectItem value="roles">{t("blocks.roles")}</SelectItem></SelectContent></Select>
            <Select value={blockDomainFilter} onValueChange={setBlockDomainFilter}><SelectTrigger aria-label={t("blocks.domainFilter")} className="min-w-0 gap-2 [&>span]:min-w-0 [&>span]:truncate"><SelectValue /></SelectTrigger><SelectContent><SelectItem value={allMailboxBlockDomains}>{t("blocks.allDomainScopes")}</SelectItem>{blockFilterDomains.map(domain => <SelectItem key={domain} value={domain}>{domain === ALL_MAILBOX_BLOCK_DOMAINS ? t("blocks.allDomains") : domain}</SelectItem>)}</SelectContent></Select>
            <Button type="button" variant="outline" className="min-w-0 sm:col-span-2 xl:col-span-1" disabled={!blockFiltersActive} onClick={() => { setBlockSearch(""); setBlockScopeFilter("all"); setBlockDomainFilter(allMailboxBlockDomains) }}><X className="mr-1 h-4 w-4 shrink-0" />{t("blocks.clearFilters")}</Button>
          </div>

          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{t("blocks.resultCount", { filtered: filteredBlocks.length, total: blocks.length })}</span>
            {filteredBlocks.length > 0 && <span>{t("blocks.range", { start: blockRangeStart, end: blockRangeEnd, total: filteredBlocks.length })}</span>}
          </div>

          {blocks.length === 0 ? <div className="rounded border border-dashed p-6 text-center text-sm text-muted-foreground">{t("blocks.empty")}</div> : filteredBlocks.length === 0 ? <div className="space-y-3 rounded border border-dashed p-6 text-center text-sm text-muted-foreground"><p>{t("blocks.noSearchResults")}</p>{blockFiltersActive && <Button type="button" size="sm" variant="outline" onClick={() => { setBlockSearch(""); setBlockScopeFilter("all"); setBlockDomainFilter(allMailboxBlockDomains) }}>{t("blocks.clearFilters")}</Button>}</div> : <div className="overflow-hidden rounded-md border">{pagedBlocks.map(block => <div key={block.id} className={`grid min-w-0 gap-2 border-b p-2.5 transition-colors last:border-b-0 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,.9fr)_auto] sm:items-center ${editingBlockId === block.id ? "bg-primary/[0.05]" : "hover:bg-muted/40"}`}><div className="min-w-0 truncate font-mono text-sm" title={blockAddress(block)}>{blockAddress(block)}</div><div className="min-w-0 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{blockScopeDescription(block)}</div><div className="flex justify-end gap-1"><Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label={t("blocks.editAddress", { address: blockAddress(block) })} title={t("blocks.edit")} disabled={savingBlock || deletingBlockId === block.id} onClick={() => editBlock(block)}><Pencil className="h-4 w-4" /></Button><AlertDialog><AlertDialogTrigger asChild><Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-destructive" aria-label={t("blocks.deleteAddress", { address: blockAddress(block) })} title={t("blocks.delete")} disabled={savingBlock || deletingBlockId === block.id}>{deletingBlockId === block.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t("blocks.deleteTitle")}</AlertDialogTitle><AlertDialogDescription>{t("blocks.deleteDescription", { address: blockAddress(block) })}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{t("blocks.cancel")}</AlertDialogCancel><AlertDialogAction onClick={() => void deleteBlock(block.id)}>{t("blocks.delete")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></div></div>)}</div>}

          {filteredBlocks.length > mailboxBlockPageSize && <div className="flex min-w-0 items-center justify-between gap-3"><Button type="button" size="sm" variant="outline" disabled={currentBlockPage <= 1} onClick={() => setBlockPage(page => Math.max(1, page - 1))}><ChevronLeft className="mr-1 h-4 w-4" />{t("blocks.previous")}</Button><span className="text-xs text-muted-foreground">{t("blocks.page", { page: currentBlockPage, pages: blockPageCount })}</span><Button type="button" size="sm" variant="outline" disabled={currentBlockPage >= blockPageCount} onClick={() => setBlockPage(page => Math.min(blockPageCount, page + 1))}>{t("blocks.next")}<ChevronRight className="ml-1 h-4 w-4" /></Button></div>}
        </TabsContent>
      </Tabs>
    </div>
  )
}
