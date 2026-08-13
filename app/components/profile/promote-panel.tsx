"use client"

import { useTranslations } from "next-intl"
import Image from "next/image"
import { Button } from "@/components/ui/button"
import { Crown, Gem, Sword, User2, Loader2, Search, ChevronLeft, ChevronRight, Users, Trash2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { useState, useEffect, useCallback } from "react"
import { useToast } from "@/components/ui/use-toast"
import { ROLES, Role } from "@/lib/permissions"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import { readApiErrorCode } from "@/lib/api-error-client"
import { LocalizedUiError, localizedUiErrorMessage } from "@/lib/localized-ui-error"

type RoleWithoutEmperor = Exclude<Role, typeof ROLES.EMPEROR>

interface UserItem {
  id: string
  name: string | null
  username: string | null
  email: string | null
  image: string | null
  role: string | null
}

const PAGE_SIZE = 10

export function PromotePanel() {
  const t = useTranslations("profile.promote")
  const tCard = useTranslations("profile.card")
  const tApi = useTranslations("api")
  const [users, setUsers] = useState<UserItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(true)
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null)
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null)
  const [userToDelete, setUserToDelete] = useState<UserItem | null>(null)
  const { toast } = useToast()

  const roleNames = {
    [ROLES.EMPEROR]: tCard("roles.EMPEROR"),
    [ROLES.DUKE]: tCard("roles.DUKE"),
    [ROLES.KNIGHT]: tCard("roles.KNIGHT"),
    [ROLES.CIVILIAN]: tCard("roles.CIVILIAN"),
  } as const

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: PAGE_SIZE.toString(),
      })
      if (search.trim()) {
        params.set("search", search.trim())
      }
      const res = await fetch(`/api/roles/users?${params}`)
      if (!res.ok) throw new LocalizedUiError(tApi(await readApiErrorCode(res, "USERS_READ_FAILED") as never))
      const data = await res.json() as {
        users: UserItem[]
        total: number
        page: number
        pageSize: number
      }
      setUsers(data.users)
      setTotal(data.total)
    } catch (error) {
      toast({
        title: t("updateFailed"),
        description: localizedUiErrorMessage(error, t("updateFailed")),
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }, [page, search, t, tApi, toast])

  useEffect(() => {
    fetchUsers()
  }, [fetchUsers])

  useEffect(() => {
    setPage(1)
  }, [search])

  const handleRoleChange = async (userId: string, newRole: RoleWithoutEmperor) => {
    setUpdatingUserId(userId)
    try {
      const res = await fetch("/api/roles/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, roleName: newRole }),
      })
      if (!res.ok) throw new LocalizedUiError(tApi(await readApiErrorCode(res, "ROLE_UPDATE_FAILED") as never))
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, role: newRole } : u))
      )
      toast({ title: t("updateSuccess") })
    } catch (error) {
      toast({
        title: t("updateFailed"),
        description: localizedUiErrorMessage(error, t("updateFailed")),
        variant: "destructive",
      })
    } finally {
      setUpdatingUserId(null)
    }
  }

  const handleDelete = async (user: UserItem) => {
    setDeletingUserId(user.id)
    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: "DELETE",
      })
      if (!res.ok) throw new LocalizedUiError(tApi(await readApiErrorCode(res, "USER_DELETE_FAILED") as never))
      toast({ title: t("deleteSuccess") })
      setUserToDelete(null)
      // 若删除的是当前页最后一条，且不在首页，则退回上一页（useEffect 会重新拉取）
      if (users.length === 1 && page > 1) {
        setPage((p) => p - 1)
      } else {
        await fetchUsers()
      }
    } catch (error) {
      toast({
        title: t("deleteFailed"),
        description: localizedUiErrorMessage(error, t("deleteFailed")),
        variant: "destructive",
      })
    } finally {
      setDeletingUserId(null)
    }
  }

  return (
    <div className="rounded-lg border-2 border-primary/20 bg-background p-4 sm:p-6">
      <div className="flex items-center gap-2 mb-6">
        <Users className="w-5 h-5 text-primary" />
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <span className="text-sm text-muted-foreground ml-auto">
          {t("totalUsers", { count: total })}
        </span>
      </div>

      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("searchPlaceholder")}
          className="pl-9"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
          <span className="ml-2 text-muted-foreground">{t("loading")}</span>
        </div>
      ) : users.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          {t("noUsers")}
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {users.map((user) => {
              const isEmperor = user.role === ROLES.EMPEROR
              const isUpdating = updatingUserId === user.id

              return (
                <div
                  key={user.id}
                  className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:bg-accent/50 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
                >
                  {user.image ? (
                    <Image
                      src={user.image}
                      alt=""
                      width={32}
                      height={32}
                      unoptimized
                      className="w-8 h-8 rounded-full"
                    />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                      <User2 className="w-4 h-4 text-primary" />
                    </div>
                  )}

                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm truncate">
                      {user.name || user.username || "—"}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {user.email || user.username || "—"}
                    </div>
                  </div>

                  {isEmperor ? (
                    <div className="col-span-2 flex items-center gap-1.5 pl-11 text-sm font-medium text-amber-600 sm:col-span-1 sm:pl-0">
                      <Crown className="w-4 h-4" />
                      {roleNames[ROLES.EMPEROR]}
                    </div>
                  ) : (
                    <div className="col-span-2 flex min-w-0 items-center gap-2 pl-11 sm:col-span-1 sm:pl-0">
                      <div className="relative">
                        {isUpdating && (
                          <div className="absolute inset-0 flex items-center justify-center bg-background/80 rounded z-10">
                            <Loader2 className="w-4 h-4 animate-spin" />
                          </div>
                        )}
                        <Select
                          value={user.role || ROLES.CIVILIAN}
                          onValueChange={(v) => handleRoleChange(user.id, v as RoleWithoutEmperor)}
                          disabled={isUpdating}
                        >
                          <SelectTrigger className="h-8 w-full min-w-0 text-sm sm:w-auto sm:min-w-28">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={ROLES.DUKE}>
                              <div className="flex items-center gap-2">
                                <Gem className="w-4 h-4" />
                                {roleNames[ROLES.DUKE]}
                              </div>
                            </SelectItem>
                            <SelectItem value={ROLES.KNIGHT}>
                              <div className="flex items-center gap-2">
                                <Sword className="w-4 h-4" />
                                {roleNames[ROLES.KNIGHT]}
                              </div>
                            </SelectItem>
                            <SelectItem value={ROLES.CIVILIAN}>
                              <div className="flex items-center gap-2">
                                <User2 className="w-4 h-4" />
                                {roleNames[ROLES.CIVILIAN]}
                              </div>
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        onClick={() => setUserToDelete(user)}
                        title={t("deleteUser")}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                <ChevronLeft className="w-4 h-4 mr-1" />
                {t("prevPage")}
              </Button>
              <span className="text-sm text-muted-foreground">
                {t("pageInfo", { current: page, total: totalPages })}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
              >
                {t("nextPage")}
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          )}
        </>
      )}

      <AlertDialog
        open={!!userToDelete}
        onOpenChange={(open) => {
          if (!open && !deletingUserId) setUserToDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteConfirm", {
                name:
                  userToDelete?.name ||
                  userToDelete?.username ||
                  userToDelete?.email ||
                  "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!deletingUserId}>
              {t("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={!!deletingUserId}
              onClick={(e) => {
                e.preventDefault()
                if (userToDelete) handleDelete(userToDelete)
              }}
            >
              {deletingUserId ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                t("deleteConfirmButton")
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
