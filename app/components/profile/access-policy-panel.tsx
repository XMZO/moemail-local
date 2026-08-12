"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Crown, Loader2, RotateCcw, Save, Search, ShieldCheck, UserCog } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useToast } from "@/components/ui/use-toast"
import { PERMISSIONS, ROLES, type Permission } from "@/lib/permissions"

const quotaKeys = [
  "maxActiveMailboxes",
  "maxMailboxLifetimeDays",
  "dailySendLimit",
  "dailyReceiveLimit",
  "maxMessageBytes",
] as const
type QuotaKey = typeof quotaKeys[number]
type EditableRole = typeof ROLES.DUKE | typeof ROLES.KNIGHT | typeof ROLES.CIVILIAN
type RolePolicy = {
  permissions: Record<Permission, boolean>
  quotas: Record<QuotaKey, number>
}
type UserOverride = {
  permissions: Partial<Record<Permission, boolean>>
  quotas: Partial<Record<QuotaKey, number>>
}
interface AccessPolicies {
  version: 1
  roles: Record<EditableRole, RolePolicy>
  users: Record<string, UserOverride>
}
interface UserItem {
  id: string
  name: string | null
  username: string | null
  email: string | null
  role: string | null
  accessOverride: UserOverride | null
}

const permissionLabels: Record<Permission, string> = {
  [PERMISSIONS.VIEW_EMAIL]: "查看邮件",
  [PERMISSIONS.CREATE_EMAIL]: "创建邮箱",
  [PERMISSIONS.DELETE_EMAIL]: "删除邮箱/邮件",
  [PERMISSIONS.RECEIVE_EMAIL]: "接收邮件",
  [PERMISSIONS.SEND_EMAIL]: "发送邮件",
  [PERMISSIONS.SHARE_EMAIL]: "创建分享链接",
  [PERMISSIONS.MANAGE_WEBHOOK]: "管理 Webhook",
  [PERMISSIONS.PROMOTE_USER]: "管理用户角色",
  [PERMISSIONS.MANAGE_CONFIG]: "管理站点与域名配置",
  [PERMISSIONS.MANAGE_API_KEY]: "管理 API Key",
}

const quotaLabels: Record<QuotaKey, { label: string; help: string }> = {
  maxActiveMailboxes: { label: "活动邮箱上限", help: "0 = 不限" },
  maxMailboxLifetimeDays: { label: "邮箱最长有效期（天）", help: "0 = 不限" },
  dailySendLimit: { label: "每日发件数", help: "0 = 不限" },
  dailyReceiveLimit: { label: "每日收件数", help: "0 = 不限" },
  maxMessageBytes: { label: "单封收件字节数", help: "0 = 仅受系统 25 MiB 硬上限" },
}

const emptyOverride = (): UserOverride => ({ permissions: {}, quotas: {} })

export function AccessPolicyPanel() {
  const [policies, setPolicies] = useState<AccessPolicies | null>(null)
  const [defaults, setDefaults] = useState<AccessPolicies | null>(null)
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [role, setRole] = useState<EditableRole>(ROLES.DUKE)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [users, setUsers] = useState<UserItem[]>([])
  const [search, setSearch] = useState("")
  const [selectedUserId, setSelectedUserId] = useState("")
  const [override, setOverride] = useState<UserOverride>(emptyOverride)
  const { toast } = useToast()

  const loadPolicies = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const response = await fetch("/api/access-policies", { cache: "no-store" })
      const body = await response.json() as {
        policies?: AccessPolicies
        defaults?: AccessPolicies
        permissions?: Permission[]
        error?: string
      }
      if (!response.ok || !body.policies || !body.defaults || !body.permissions) {
        throw new Error(body.error || "读取权限策略失败")
      }
      setPolicies(body.policies)
      setDefaults(body.defaults)
      setPermissions(body.permissions)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "读取权限策略失败")
    } finally {
      setLoading(false)
    }
  }, [])

  const loadUsers = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page: "1", pageSize: "50" })
      if (search.trim()) params.set("search", search.trim())
      const response = await fetch(`/api/roles/users?${params}`, { cache: "no-store" })
      const body = await response.json() as { users?: UserItem[]; error?: string }
      if (!response.ok || !body.users) throw new Error(body.error || "读取用户失败")
      setUsers(body.users)
      if (selectedUserId && !body.users.some(user => user.id === selectedUserId)) {
        setSelectedUserId("")
        setOverride(emptyOverride())
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "读取用户失败")
    }
  }, [search, selectedUserId])

  useEffect(() => { void loadPolicies() }, [loadPolicies])
  useEffect(() => {
    const timeout = setTimeout(() => { void loadUsers() }, 250)
    return () => clearTimeout(timeout)
  }, [loadUsers])

  const selectedUser = useMemo(
    () => users.find(user => user.id === selectedUserId) ?? null,
    [selectedUserId, users],
  )
  const rolePolicy = policies?.roles[role]

  const saveRoles = async () => {
    if (!policies) return
    setSaving(true)
    setError("")
    try {
      const response = await fetch("/api/access-policies", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roles: policies.roles }),
      })
      const body = await response.json() as { policies?: AccessPolicies; error?: string }
      if (!response.ok || !body.policies) throw new Error(body.error || "保存权限策略失败")
      setPolicies(body.policies)
      toast({ title: "角色权限与配额已保存" })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存权限策略失败")
    } finally {
      setSaving(false)
    }
  }

  const selectUser = (id: string) => {
    setSelectedUserId(id)
    const user = users.find(item => item.id === id)
    setOverride(user?.accessOverride
      ? { permissions: { ...user.accessOverride.permissions }, quotas: { ...user.accessOverride.quotas } }
      : emptyOverride())
  }

  const saveUserOverride = async () => {
    if (!selectedUser || selectedUser.role === ROLES.EMPEROR) return
    setSaving(true)
    setError("")
    try {
      const response = await fetch(`/api/access-policies/users/${encodeURIComponent(selectedUser.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(override),
      })
      const body = await response.json() as { override?: UserOverride; error?: string }
      if (!response.ok || !body.override) throw new Error(body.error || "保存用户覆盖失败")
      setOverride(body.override)
      setUsers(previous => previous.map(user => user.id === selectedUser.id ? { ...user, accessOverride: body.override! } : user))
      toast({ title: "用户权限覆盖已保存" })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存用户覆盖失败")
    } finally {
      setSaving(false)
    }
  }

  const resetUserOverride = async () => {
    if (!selectedUser || selectedUser.role === ROLES.EMPEROR) return
    setSaving(true)
    setError("")
    try {
      const response = await fetch(`/api/access-policies/users/${encodeURIComponent(selectedUser.id)}`, { method: "DELETE" })
      const body = await response.json() as { ok?: boolean; error?: string }
      if (!response.ok || !body.ok) throw new Error(body.error || "重置用户覆盖失败")
      setOverride(emptyOverride())
      setUsers(previous => previous.map(user => user.id === selectedUser.id ? { ...user, accessOverride: null } : user))
      toast({ title: "用户已恢复继承角色默认值" })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "重置用户覆盖失败")
    } finally {
      setSaving(false)
    }
  }

  if (loading || !policies || !defaults || !rolePolicy) {
    return <div className="flex min-h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
  }

  return (
    <div className="rounded-lg border-2 border-primary/20 bg-background p-4 sm:p-5">
      <div className="mb-4 flex items-start gap-2">
        <ShieldCheck className="mt-0.5 h-5 w-5 text-primary" />
        <div><h2 className="font-semibold">权限与配额</h2><p className="text-xs text-muted-foreground">0 表示不限。皇帝权限始终由代码固定为全部允许且不限额，任何 API 都不能覆盖。</p></div>
      </div>
      {error && <div className="mb-4 rounded border border-destructive/60 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

      <Tabs defaultValue="roles">
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="roles">角色默认值</TabsTrigger>
          <TabsTrigger value="users">单用户覆盖</TabsTrigger>
        </TabsList>

        <TabsContent value="roles" className="space-y-4 pt-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Select value={role} onValueChange={value => setRole(value as EditableRole)}><SelectTrigger className="w-44"><SelectValue /></SelectTrigger><SelectContent><SelectItem value={ROLES.DUKE}>Duke</SelectItem><SelectItem value={ROLES.KNIGHT}>Knight</SelectItem><SelectItem value={ROLES.CIVILIAN}>Civilian</SelectItem></SelectContent></Select>
            <div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => setPolicies(previous => previous ? { ...previous, roles: { ...previous.roles, [role]: structuredClone(defaults.roles[role]) } } : previous)}><RotateCcw className="mr-1 h-4 w-4" />重置此角色</Button><Button size="sm" onClick={() => void saveRoles()} disabled={saving}><Save className="mr-1 h-4 w-4" />保存</Button></div>
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <section className="rounded border p-4"><h3 className="mb-3 text-sm font-medium">功能权限</h3><div className="grid gap-2 sm:grid-cols-2">{permissions.map(permission => <label key={permission} className="flex cursor-pointer items-center gap-2 rounded border p-2 text-sm"><Checkbox checked={rolePolicy.permissions[permission]} onChange={checked => setPolicies(previous => previous ? { ...previous, roles: { ...previous.roles, [role]: { ...previous.roles[role], permissions: { ...previous.roles[role].permissions, [permission]: checked } } } } : previous)} /><span>{permissionLabels[permission]}</span></label>)}</div></section>
            <section className="rounded border p-4"><h3 className="mb-3 text-sm font-medium">额度</h3><div className="grid gap-3 sm:grid-cols-2">{quotaKeys.map(key => <div key={key} className="space-y-1"><Label>{quotaLabels[key].label}</Label><Input type="number" min={0} max={key === "maxMessageBytes" ? 25 * 1024 * 1024 : undefined} value={rolePolicy.quotas[key]} onChange={event => setPolicies(previous => previous ? { ...previous, roles: { ...previous.roles, [role]: { ...previous.roles[role], quotas: { ...previous.roles[role].quotas, [key]: Number(event.target.value) } } } } : previous)} /><p className="text-xs text-muted-foreground">{quotaLabels[key].help}</p></div>)}</div></section>
          </div>
        </TabsContent>

        <TabsContent value="users" className="space-y-4 pt-2">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(15rem,0.8fr)]">
            <div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索用户名或邮箱" className="pl-9" /></div>
            <Select value={selectedUserId} onValueChange={selectUser}><SelectTrigger><SelectValue placeholder="选择用户" /></SelectTrigger><SelectContent>{users.map(user => <SelectItem key={user.id} value={user.id}><span className="flex items-center gap-2">{user.role === ROLES.EMPEROR && <Crown className="h-3.5 w-3.5 text-amber-500" />}{user.name || user.username || user.email || user.id} · {user.role || ROLES.CIVILIAN}</span></SelectItem>)}</SelectContent></Select>
          </div>

          {!selectedUser ? <div className="rounded border border-dashed p-8 text-center text-sm text-muted-foreground"><UserCog className="mx-auto mb-2 h-6 w-6" />选择一个用户后设置覆盖值</div> : selectedUser.role === ROLES.EMPEROR ? <div className="rounded border border-amber-500/50 bg-amber-500/10 p-4 text-sm"><div className="flex items-center gap-2 font-medium"><Crown className="h-4 w-4" />皇帝权限不可编辑</div><p className="mt-1 text-muted-foreground">这是代码与后端 API 同时强制的系统不变量，包括皇帝本人也不能修改。</p></div> : (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">未覆盖的项继续继承用户角色。权限可明确允许/拒绝；额度勾选后覆盖。</p>
              <div className="grid gap-4 xl:grid-cols-2">
                <section className="rounded border p-4"><h3 className="mb-3 text-sm font-medium">权限覆盖</h3><div className="space-y-2">{permissions.map(permission => <div key={permission} className="grid grid-cols-[minmax(0,1fr)_8rem] items-center gap-2"><span className="text-sm">{permissionLabels[permission]}</span><Select value={override.permissions[permission] === undefined ? "inherit" : override.permissions[permission] ? "allow" : "deny"} onValueChange={value => setOverride(previous => { const next = { ...previous, permissions: { ...previous.permissions } }; if (value === "inherit") delete next.permissions[permission]; else next.permissions[permission] = value === "allow"; return next })}><SelectTrigger className="h-8"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="inherit">继承</SelectItem><SelectItem value="allow">允许</SelectItem><SelectItem value="deny">拒绝</SelectItem></SelectContent></Select></div>)}</div></section>
                <section className="rounded border p-4"><h3 className="mb-3 text-sm font-medium">额度覆盖</h3><div className="space-y-3">{quotaKeys.map(key => { const enabled = override.quotas[key] !== undefined; return <div key={key} className="grid grid-cols-[auto_minmax(0,1fr)_8rem] items-center gap-2"><Checkbox checked={enabled} onChange={checked => setOverride(previous => { const quotas = { ...previous.quotas }; if (checked) quotas[key] = policies.roles[(selectedUser.role as EditableRole) || ROLES.CIVILIAN]?.quotas[key] ?? defaults.roles[ROLES.CIVILIAN].quotas[key]; else delete quotas[key]; return { ...previous, quotas } })} /><span className="text-sm">{quotaLabels[key].label}</span><Input className="h-8" type="number" disabled={!enabled} min={0} max={key === "maxMessageBytes" ? 25 * 1024 * 1024 : undefined} value={override.quotas[key] ?? ""} onChange={event => setOverride(previous => ({ ...previous, quotas: { ...previous.quotas, [key]: Number(event.target.value) } }))} /></div> })}</div></section>
              </div>
              <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => void resetUserOverride()} disabled={saving}><RotateCcw className="mr-1 h-4 w-4" />全部继承</Button><Button onClick={() => void saveUserOverride()} disabled={saving}><Save className="mr-1 h-4 w-4" />保存用户覆盖</Button></div>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
