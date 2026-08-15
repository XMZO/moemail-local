"use client"

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import Image from "next/image"
import {
  Ban,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Crown,
  Eye,
  Gem,
  Loader2,
  Search,
  ShieldCheck,
  Sword,
  Trash2,
  User2,
  Users,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { useToast } from "@/components/ui/use-toast"
import { ROLES, type Role } from "@/lib/permissions"
import { readApiErrorCode } from "@/lib/api-error-client"
import { LocalizedUiError, localizedUiErrorMessage } from "@/lib/localized-ui-error"
import { UserDetailsDialog, type ManagedUser } from "./user-details-dialog"

type RoleWithoutEmperor = Exclude<Role, typeof ROLES.EMPEROR>

const PAGE_SIZE = 12

export function PromotePanel({ currentUserId }: { currentUserId?: string }) {
  const t = useTranslations("profile.promote")
  const tCard = useTranslations("profile.card")
  const tApi = useTranslations("api")
  const { toast } = useToast()
  const [users, setUsers] = useState<ManagedUser[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState("")
  const [roleFilter, setRoleFilter] = useState("all")
  const [statusFilter, setStatusFilter] = useState("all")
  const [mailboxFilter, setMailboxFilter] = useState("all")
  const [loading, setLoading] = useState(true)
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null)
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null)
  const [userToDelete, setUserToDelete] = useState<ManagedUser | null>(null)
  const [userToToggle, setUserToToggle] = useState<ManagedUser | null>(null)
  const [detailsUser, setDetailsUser] = useState<ManagedUser | null>(null)

  const roleNames = {
    [ROLES.EMPEROR]: tCard("roles.EMPEROR"),
    [ROLES.DUKE]: tCard("roles.DUKE"),
    [ROLES.KNIGHT]: tCard("roles.KNIGHT"),
    [ROLES.CIVILIAN]: tCard("roles.CIVILIAN"),
  } as const

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const displayName = (user: ManagedUser) => user.name || user.username || user.email || user.id
  const isEmperor = (user: ManagedUser) => user.role === ROLES.EMPEROR
  const isSelf = (user: ManagedUser) => user.id === currentUserId

  const fetchUsers = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: PAGE_SIZE.toString(),
        role: roleFilter,
        status: statusFilter,
        mailboxes: mailboxFilter,
      })
      if (search.trim()) params.set("search", search.trim())
      const response = await fetch(`/api/roles/users?${params}`, { cache: "no-store", signal })
      const body = await response.json() as { users?: ManagedUser[]; total?: number }
      if (!response.ok || !body.users || body.total === undefined) {
        throw new LocalizedUiError(tApi(await readApiErrorCode(response, "USERS_READ_FAILED") as never))
      }
      setUsers(body.users)
      setTotal(body.total)
    } catch (caught) {
      if (caught instanceof Error && caught.name === "AbortError") return
      toast({ title: t("updateFailed"), description: localizedUiErrorMessage(caught, t("updateFailed")), variant: "destructive" })
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [mailboxFilter, page, roleFilter, search, statusFilter, t, tApi, toast])

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => void fetchUsers(controller.signal), 120)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [fetchUsers])

  useEffect(() => { setPage(1) }, [search, roleFilter, statusFilter, mailboxFilter])
  useEffect(() => { if (page > totalPages) setPage(totalPages) }, [page, totalPages])

  const handleRoleChange = async (userId: string, newRole: RoleWithoutEmperor) => {
    setUpdatingUserId(userId)
    try {
      const response = await fetch("/api/roles/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, roleName: newRole }),
      })
      if (!response.ok) throw new LocalizedUiError(tApi(await readApiErrorCode(response, "ROLE_UPDATE_FAILED") as never))
      setUsers(previous => previous.map(user => user.id === userId ? { ...user, role: newRole } : user))
      toast({ title: t("updateSuccess") })
    } catch (caught) {
      toast({ title: t("updateFailed"), description: localizedUiErrorMessage(caught, t("updateFailed")), variant: "destructive" })
    } finally {
      setUpdatingUserId(null)
    }
  }

  const handleStatusChange = async (user: ManagedUser) => {
    const nextBanned = !Boolean(user.bannedAt)
    setUpdatingUserId(user.id)
    try {
      const response = await fetch(`/api/users/${encodeURIComponent(user.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ banned: nextBanned, expectedBanned: !nextBanned }),
      })
      if (!response.ok) throw new LocalizedUiError(tApi(await readApiErrorCode(response, nextBanned ? "USER_BAN_FAILED" : "USER_UNBAN_FAILED") as never))
      setUsers(previous => previous.map(item => item.id === user.id ? { ...item, bannedAt: nextBanned ? new Date().toISOString() : null } : item))
      setDetailsUser(previous => previous?.id === user.id ? { ...previous, bannedAt: nextBanned ? new Date().toISOString() : null } : previous)
      setUserToToggle(null)
      toast({ title: t(nextBanned ? "banSuccess" : "unbanSuccess") })
    } catch (caught) {
      toast({ title: t(nextBanned ? "banFailed" : "unbanFailed"), description: localizedUiErrorMessage(caught, t(nextBanned ? "banFailed" : "unbanFailed")), variant: "destructive" })
    } finally {
      setUpdatingUserId(null)
    }
  }

  const handleDelete = async (user: ManagedUser) => {
    setDeletingUserId(user.id)
    try {
      const response = await fetch(`/api/users/${encodeURIComponent(user.id)}`, { method: "DELETE" })
      if (!response.ok) throw new LocalizedUiError(tApi(await readApiErrorCode(response, "USER_DELETE_FAILED") as never))
      toast({ title: t("deleteSuccess") })
      setUserToDelete(null)
      if (users.length === 1 && page > 1) setPage(previous => previous - 1)
      else await fetchUsers()
    } catch (caught) {
      toast({ title: t("deleteFailed"), description: localizedUiErrorMessage(caught, t("deleteFailed")), variant: "destructive" })
    } finally {
      setDeletingUserId(null)
    }
  }

  return (
    <div className="rounded-lg border-2 border-primary/20 bg-background p-4 sm:p-6">
      <div className="mb-5 flex min-w-0 items-center gap-2"><Users className="h-5 w-5 shrink-0 text-primary" /><div className="min-w-0"><h2 className="truncate text-lg font-semibold">{t("title")}</h2><p className="text-xs leading-relaxed text-muted-foreground">{t("description")}</p></div><span className="ml-auto shrink-0 text-xs text-muted-foreground">{t("totalUsers", { count: total })}</span></div>

      <div className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_10rem_10rem_10rem]">
        <div className="relative min-w-0 sm:col-span-2 lg:col-span-1"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={search} onChange={event => setSearch(event.target.value)} placeholder={t("searchPlaceholder")} className="min-w-0 pl-9" /></div>
        <Select value={roleFilter} onValueChange={setRoleFilter}><SelectTrigger className="h-8 w-full min-w-0 text-sm sm:w-auto sm:min-w-28" aria-label={t("filters.role")}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t("filters.allRoles")}</SelectItem><SelectItem value={ROLES.EMPEROR}>{roleNames[ROLES.EMPEROR]}</SelectItem><SelectItem value={ROLES.DUKE}>{roleNames[ROLES.DUKE]}</SelectItem><SelectItem value={ROLES.KNIGHT}>{roleNames[ROLES.KNIGHT]}</SelectItem><SelectItem value={ROLES.CIVILIAN}>{roleNames[ROLES.CIVILIAN]}</SelectItem></SelectContent></Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}><SelectTrigger aria-label={t("filters.status")} className="min-w-0"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t("filters.allStatuses")}</SelectItem><SelectItem value="active">{t("filters.active")}</SelectItem><SelectItem value="banned">{t("filters.banned")}</SelectItem></SelectContent></Select>
        <Select value={mailboxFilter} onValueChange={setMailboxFilter}><SelectTrigger aria-label={t("filters.mailboxes")} className="min-w-0"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t("filters.allMailboxes")}</SelectItem><SelectItem value="with">{t("filters.withMailboxes")}</SelectItem><SelectItem value="without">{t("filters.withoutMailboxes")}</SelectItem></SelectContent></Select>
      </div>

      <div className="mt-4 min-h-56">
        {loading ? <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin text-primary" />{t("loading")}</div> : users.length === 0 ? <div className="py-12 text-center text-sm text-muted-foreground">{t("noUsers")}</div> : <div className="space-y-2">{users.map(user => {
          const emperor = isEmperor(user)
          const self = isSelf(user)
          const updating = updatingUserId === user.id
          return <div key={user.id} className={`grid min-w-0 gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/50 sm:grid-cols-[auto_minmax(0,1fr)_auto] ${user.bannedAt ? "border-destructive/40 bg-destructive/[0.03]" : ""}`}>
            {user.image ? <Image src={user.image} alt="" width={36} height={36} unoptimized className="h-9 w-9 rounded-full" /> : <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10"><User2 className="h-4 w-4 text-primary" /></div>}
            <div className="min-w-0"><div className="flex min-w-0 flex-wrap items-center gap-2"><span className="min-w-0 truncate text-sm font-medium">{displayName(user)}</span><span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${user.bannedAt ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}>{user.bannedAt ? <ShieldCheck className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}{user.bannedAt ? t("status.banned") : t("status.active")}</span></div><div className="truncate text-xs text-muted-foreground">{user.email || user.username || user.id}</div><div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground"><span>{roleNames[(user.role || ROLES.CIVILIAN) as Role] || roleNames[ROLES.CIVILIAN]}</span><span>{t("mailboxCount", { count: user.mailboxCount })}</span></div></div>
            <div className="col-span-2 flex min-w-0 items-center justify-end gap-1 sm:col-span-1"><div className="min-w-0 flex-1 sm:flex-none">{emperor ? <div className="flex items-center justify-end gap-1.5 text-sm font-medium text-amber-600"><Crown className="h-4 w-4" />{roleNames[ROLES.EMPEROR]}</div> : <Select value={user.role || ROLES.CIVILIAN} onValueChange={value => void handleRoleChange(user.id, value as RoleWithoutEmperor)} disabled={updating}><SelectTrigger className="h-8 min-w-0 text-sm sm:w-28"><SelectValue /></SelectTrigger><SelectContent><SelectItem value={ROLES.DUKE}><span className="flex items-center gap-2"><Gem className="h-4 w-4" />{roleNames[ROLES.DUKE]}</span></SelectItem><SelectItem value={ROLES.KNIGHT}><span className="flex items-center gap-2"><Sword className="h-4 w-4" />{roleNames[ROLES.KNIGHT]}</span></SelectItem><SelectItem value={ROLES.CIVILIAN}><span className="flex items-center gap-2"><User2 className="h-4 w-4" />{roleNames[ROLES.CIVILIAN]}</span></SelectItem></SelectContent></Select>}</div><Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => setDetailsUser(user)} title={t("details.open")} aria-label={t("details.openFor", { name: displayName(user) })}><Eye className="h-4 w-4" /></Button>{!emperor && <Button variant="ghost" size="icon" className={`h-8 w-8 shrink-0 ${user.bannedAt ? "text-emerald-600 hover:text-emerald-700" : "text-amber-600 hover:text-amber-700"}`} disabled={self || updating} onClick={() => setUserToToggle(user)} title={self ? t("status.selfDisabled") : user.bannedAt ? t("unban") : t("ban")} aria-label={user.bannedAt ? t("unbanFor", { name: displayName(user) }) : t("banFor", { name: displayName(user) })}>{updating ? <Loader2 className="h-4 w-4 animate-spin" /> : user.bannedAt ? <ShieldCheck className="h-4 w-4" /> : <Ban className="h-4 w-4" />}</Button>}{!emperor && <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive" disabled={self || !!updatingUserId || !!deletingUserId} onClick={() => setUserToDelete(user)} title={self ? t("deleteSelfDisabled") : t("deleteUser")} aria-label={t("deleteFor", { name: displayName(user) })}><Trash2 className="h-4 w-4" /></Button>}</div>
          </div>
        })}</div>}
      </div>

      {totalPages > 1 && <div className="mt-4 flex items-center justify-between gap-3 border-t pt-4"><Button variant="outline" size="sm" onClick={() => setPage(previous => Math.max(1, previous - 1))} disabled={page <= 1 || loading}><ChevronLeft className="mr-1 h-4 w-4" />{t("prevPage")}</Button><span className="text-xs text-muted-foreground">{t("pageInfo", { current: page, total: totalPages })}</span><Button variant="outline" size="sm" onClick={() => setPage(previous => Math.min(totalPages, previous + 1))} disabled={page >= totalPages || loading}>{t("nextPage")}<ChevronRight className="ml-1 h-4 w-4" /></Button></div>}

      <AlertDialog open={!!userToToggle} onOpenChange={open => { if (!open && !updatingUserId) setUserToToggle(null) }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{userToToggle?.bannedAt ? t("unbanTitle") : t("banTitle")}</AlertDialogTitle><AlertDialogDescription>{userToToggle?.bannedAt ? t("unbanDescription", { name: userToToggle ? displayName(userToToggle) : "" }) : t("banDescription", { name: userToToggle ? displayName(userToToggle) : "" })}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={!!updatingUserId}>{t("cancel")}</AlertDialogCancel><AlertDialogAction disabled={!!updatingUserId} onClick={event => { event.preventDefault(); if (userToToggle) void handleStatusChange(userToToggle) }}>{updatingUserId ? <Loader2 className="h-4 w-4 animate-spin" /> : userToToggle?.bannedAt ? t("unban") : t("ban")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>

      <AlertDialog open={!!userToDelete} onOpenChange={open => { if (!open && !deletingUserId) setUserToDelete(null) }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle><AlertDialogDescription>{t("deleteConfirm", { name: userToDelete ? displayName(userToDelete) : "" })}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={!!deletingUserId}>{t("cancel")}</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={!!deletingUserId} onClick={event => { event.preventDefault(); if (userToDelete) void handleDelete(userToDelete) }}>{deletingUserId ? <Loader2 className="h-4 w-4 animate-spin" /> : t("deleteConfirmButton")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>

      <UserDetailsDialog user={detailsUser} open={!!detailsUser} onOpenChange={open => { if (!open) setDetailsUser(null) }} />
    </div>
  )
}
