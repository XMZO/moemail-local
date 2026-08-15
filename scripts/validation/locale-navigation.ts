import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { NextRequest } from "next/server"
import { middleware } from "../../middleware"
import { localizedHref } from "../../app/i18n/navigation"

assert.equal(
  localizedHref("/zh-CN/profile", "tab=runtime&safe-appearance=1", "advanced"),
  "/profile?tab=runtime&safe-appearance=1#advanced",
)
assert.equal(localizedHref("/en", "", ""), "/")
assert.equal(localizedHref("/shared/token", "cursor=abc", "message"), "/shared/token?cursor=abc#message")
assert.equal(localizedHref("profile/", "?tab=domains", "#mail"), "/profile?tab=domains#mail")

const cookieRewrite = middleware(new NextRequest("https://mail.example/profile?tab=runtime", {
  headers: { cookie: "NEXT_LOCALE=zh-CN" },
}))
assert.equal(cookieRewrite.status, 200)
assert.equal(cookieRewrite.headers.get("location"), null)
assert.equal(
  new URL(cookieRewrite.headers.get("x-middleware-rewrite") as string).pathname,
  "/zh-CN/profile",
)
assert.equal(cookieRewrite.headers.get("content-language"), "zh-CN")
assert.match(cookieRewrite.headers.get("vary") ?? "", /Cookie/u)
assert.match(cookieRewrite.headers.get("vary") ?? "", /Accept-Language/u)

const headerRewrite = middleware(new NextRequest("https://mail.example/login", {
  headers: { "accept-language": "zh-TW,zh;q=0.9,en;q=0.8" },
}))
assert.equal(
  new URL(headerRewrite.headers.get("x-middleware-rewrite") as string).pathname,
  "/zh-TW/login",
)

const legacyPass = middleware(new NextRequest("https://mail.example/ja/profile?tab=appearance"))
assert.equal(legacyPass.status, 200)
assert.equal(legacyPass.headers.get("x-middleware-next"), "1")
assert.equal(legacyPass.headers.get("location"), null)
assert.match(legacyPass.headers.get("set-cookie") ?? "", /NEXT_LOCALE=ja/u)

const internalRewritePass = middleware(new NextRequest("https://mail.example/ja/profile", {
  headers: { "x-moemail-internal-locale-rewrite": "1" },
}))
assert.equal(internalRewritePass.headers.get("x-middleware-next"), "1")
assert.equal(internalRewritePass.headers.get("location"), null)

const apiPassThrough = middleware(new NextRequest("https://mail.example/api/internal/health"))
assert.equal(apiPassThrough.headers.get("x-middleware-next"), "1")
assert.equal(apiPassThrough.headers.get("x-middleware-rewrite"), null)

const switcherSource = readFileSync(join(process.cwd(), "app/hooks/use-locale-switcher.ts"), "utf8")
assert.doesNotMatch(switcherSource, /useRouter|router\.(?:push|replace|refresh)\s*\(/u, "locale switching must not wait for navigation")
assert.match(switcherSource, /useInstantLocale/u)

const providerSource = readFileSync(join(process.cwd(), "app/i18n/locale-provider.tsx"), "utf8")
assert.match(providerSource, /NextIntlClientProvider locale=\{locale\} messages=\{catalogs\[locale\]\}/u)
assert.match(providerSource, /window\.history\.replaceState/u)
assert.match(providerSource, /startViewTransition/u)
assert.match(providerSource, /NEXT_LOCALE=/u)

const globalCss = readFileSync(join(process.cwd(), "app/globals.css"), "utf8")
assert.match(globalCss, /data-locale-transition="entering"/u)
assert.match(globalCss, /::view-transition-old\(root\)/u)
assert.match(globalCss, /::view-transition-new\(root\)/u)
assert.match(globalCss, /prefers-reduced-motion: reduce/u)

const profileSource = readFileSync(join(process.cwd(), "app/components/profile/profile-card.tsx"), "utf8")
assert.match(profileSource, /searchParams\.get\("tab"\)/u)
assert.match(profileSource, /window\.history\.replaceState/u)
assert.match(profileSource, /visitedTabs/u)
assert.match(profileSource, /forceMount/u)
assert.match(profileSource, /requestIdleCallback/u)
assert.match(profileSource, /data-\[state=inactive\]:hidden/u)

const setupPageSource = readFileSync(join(process.cwd(), "app/[locale]/setup/page.tsx"), "utf8")
assert.match(setupPageSource, /<SetupHeader \/>/u)

const authSource = readFileSync(join(process.cwd(), "app/lib/auth.ts"), "utf8")
const authErrorSource = readFileSync(join(process.cwd(), "app/[locale]/auth-error/page.tsx"), "utf8")
const authErrorContentSource = readFileSync(join(process.cwd(), "app/components/auth/auth-error-content.tsx"), "utf8")
const signButtonSource = readFileSync(join(process.cwd(), "app/components/auth/sign-button.tsx"), "utf8")
const currentOriginSignOutSource = readFileSync(join(process.cwd(), "app/hooks/use-current-origin-sign-out.ts"), "utf8")
const sessionStatusGuardSource = readFileSync(join(process.cwd(), "app/components/auth/session-status-guard.tsx"), "utf8")
const apiErrorClientSource = readFileSync(join(process.cwd(), "app/lib/api-error-client.ts"), "utf8")
const loginFormSource = readFileSync(join(process.cwd(), "app/components/auth/login-form.tsx"), "utf8")
const loginPageSource = readFileSync(join(process.cwd(), "app/[locale]/login/page.tsx"), "utf8")
assert.match(authSource, /signIn:\s*"\/login"/u)
assert.match(authSource, /error:\s*"\/auth-error"/u)
assert.match(authErrorSource, /<AuthErrorContent\s*\/>/u)
assert.match(authErrorContentSource, /useTranslations\("auth\.authError"\)/u)
assert.doesNotMatch(authErrorContentSource, /useLocale\(\)/u)
assert.match(signButtonSource, /useCurrentOriginSignOut\(\)/u)
assert.match(profileSource, /useCurrentOriginSignOut\(\)/u)
assert.match(currentOriginSignOutSource, /signOut\(\{ redirect: false \}\)/u)
assert.match(currentOriginSignOutSource, /new URL\("\/", window\.location\.origin\)/u)
assert.match(currentOriginSignOutSource, /window\.location\.replace\(new URL\("\/", window\.location\.origin\)\.href\)/u)
assert.doesNotMatch(`${signButtonSource}\n${profileSource}`, /callbackUrl/u)
assert.match(authSource, /class UserBannedCredentialsError extends CredentialsSignin/u)
assert.match(authSource, /session\.user\.bannedAt = targetUser\?\.bannedAt \?\? null/u)
assert.match(loginFormSource, /result\.code === "USER_BANNED"/u)
assert.match(sessionStatusGuardSource, /signOut\(\{ redirect: false \}\)/u)
assert.match(sessionStatusGuardSource, /sessionStorage\.removeItem\(BANNED_NOTICE_KEY\)/u)
assert.match(sessionStatusGuardSource, /window\.location\.replace\(new URL\("\/", window\.location\.origin\)\.href\)/u)
assert.match(sessionStatusGuardSource, /duration: 5_000/u)
assert.match(sessionStatusGuardSource, /window\.fetch = guardedFetch/u)
assert.match(apiErrorClientSource, /code === "USER_BANNED"[\s\S]*dispatchEvent/u)
assert.doesNotMatch(loginFormSource, /min-h-\[220px\]/u)
assert.match(loginFormSource, /grid gap-3 min-\[480px\]:grid-cols-2/u)
assert.match(loginFormSource, /usernameField\("min-\[480px\]:col-span-2"\)/u)
assert.match(loginFormSource, /className="mt-4 min-h-\[65px\] items-center"/u)
assert.match(loginFormSource, /type="submit"/u)
assert.match(loginFormSource, /activeTab === "login" \? t\("actions\.login"\) : t\("actions\.register"\)/u)
assert.match(loginFormSource, /max-w-lg/u)
assert.match(loginPageSource, /min-h-\[100dvh\]/u)

const userPanelSource = readFileSync(join(process.cwd(), "app/components/profile/promote-panel.tsx"), "utf8")
const userDetailsSource = readFileSync(join(process.cwd(), "app/components/profile/user-details-dialog.tsx"), "utf8")
assert.doesNotMatch(userPanelSource, /<RoleIcon/u)
assert.match(userPanelSource, /sm:grid-cols-\[auto_minmax\(0,1fr\)_auto\]/u)
assert.match(userPanelSource, /className="h-8 w-full min-w-0 text-sm sm:w-auto sm:min-w-28"/u)
assert.match(userDetailsSource, /useLayoutEffect[\s\S]*ResizeObserver/u)
assert.match(userDetailsSource, /\[scrollbar-gutter:stable\][^"\n]*transition-\[height\]/u)
assert.match(userDetailsSource, /querySelector<HTMLElement>\('\[role="tabpanel"\]\[data-state="active"\]'\)/u)
assert.match(userDetailsSource, /if \(contentHeight <= 0\) return/u)
assert.doesNotMatch(userDetailsSource, /activePanelRef/u)
assert.match(userDetailsSource, /grid-cols-2[^"\n]*sm:grid-cols-4/u)
assert.match(userDetailsSource, /p-4 pr-14 sm:p-6 sm:pr-16/u)
assert.match(userDetailsSource, /tabViewportRef\.current\?\.scrollTo\(\{ top: 0 \}\)/u)
assert.doesNotMatch(userDetailsSource, /max-h-72 space-y-2 overflow-y-auto/u)

const accessPanelSource = readFileSync(join(process.cwd(), "app/components/profile/access-policy-panel.tsx"), "utf8")
const sendQuotaSource = readFileSync(join(process.cwd(), "app/components/profile/mail-quota-editor.tsx"), "utf8")
const quotaGuideSource = readFileSync(join(process.cwd(), "app/components/profile/mail-quota-rule-guide.tsx"), "utf8")
const searchableUserSource = readFileSync(join(process.cwd(), "app/components/profile/searchable-user-select.tsx"), "utf8")
const domainPolicySource = readFileSync(join(process.cwd(), "app/components/profile/domain-policy-panel.tsx"), "utf8")
const messageListSource = readFileSync(join(process.cwd(), "app/components/emails/message-list.tsx"), "utf8")
const emailListSource = readFileSync(join(process.cwd(), "app/components/emails/email-list.tsx"), "utf8")
const htmlFrameSource = readFileSync(join(process.cwd(), "app/components/emails/html-message-frame.tsx"), "utf8")
const messageViewSource = readFileSync(join(process.cwd(), "app/components/emails/message-view.tsx"), "utf8")
const sharedMessageSource = readFileSync(join(process.cwd(), "app/components/emails/shared-message-detail.tsx"), "utf8")
const threeColumnSource = readFileSync(join(process.cwd(), "app/components/emails/three-column-layout.tsx"), "utf8")
const appearancePanelSource = readFileSync(join(process.cwd(), "app/components/profile/appearance-panel.tsx"), "utf8")
const mailboxBlockRouteSource = readFileSync(join(process.cwd(), "app/api/access-policies/mailbox-blocks/route.ts"), "utf8")
assert.match(accessPanelSource, /ROLES\.EMPEROR, ROLES\.DUKE, ROLES\.KNIGHT, ROLES\.CIVILIAN/u)
assert.match(accessPanelSource, /<MailQuotaRuleEditor/u)
assert.match(accessPanelSource, /mailQuotaRules/u)
assert.doesNotMatch(accessPanelSource, /<RoleMailQuotaEditor|<UserMailQuotaEditor/u)
assert.match(sendQuotaSource, /subjectSpecificity|subjects\.all/u)
assert.doesNotMatch(sendQuotaSource, /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]/u)
assert.match(sendQuotaSource, /admin\.access\.mailQuota/u)
assert.match(sendQuotaSource, /RULES_PER_PAGE = 20/u)
assert.match(sendQuotaSource, /filteredRules\.slice/u)
assert.match(sendQuotaSource, /subjectFilter[\s\S]*targetFilter/u)
assert.match(sendQuotaSource, /useDeferredValue\(query\)/u)
assert.match(sendQuotaSource, /indexedRules/u)
assert.match(sendQuotaSource, /quotaFilter/u)
assert.match(sendQuotaSource, /editingRule[\s\S]*cloneAssignment/u)
assert.match(sendQuotaSource, /manager\.modes\.custom/u)
assert.match(sendQuotaSource, /raw\.trim\(\) === "" \? Number\.NaN/u)
assert.match(sendQuotaSource, /rules\.length >= 2_000/u)
assert.match(sendQuotaSource, /AlertDialogTitle/u)
assert.match(sendQuotaSource, /xl:grid-cols-\[minmax\(14rem,1fr\)_minmax\(9rem,.42fr\)_minmax\(9rem,.42fr\)_minmax\(9rem,.42fr\)\]/u)
assert.match(sendQuotaSource, /grid-cols-\[1\.25rem_minmax\(0,1fr\)\]/u)
assert.match(sendQuotaSource, /\[overflow-wrap:anywhere\]/u)
assert.match(sendQuotaSource, /\[&>span\]:truncate/u)
assert.match(sendQuotaSource, /<MailQuotaRuleGuide/u)
assert.match(sendQuotaSource, /<MailQuotaCompatibility/u)
assert.match(quotaGuideSource, /aria-live="polite"/u)
assert.match(quotaGuideSource, /unlimitedOverride/u)
assert.match(accessPanelSource, /setUsageRevision\(value => value \+ 1\)/u)
assert.match(accessPanelSource, /ALL_MAILBOX_BLOCK_DOMAINS/u)
assert.match(accessPanelSource, /blocks\.allDomains/u)
assert.match(accessPanelSource, /mailboxBlockPageSize = 12/u)
assert.match(accessPanelSource, /useDeferredValue\(blockSearch\)/u)
assert.match(accessPanelSource, /filteredBlocks\.slice/u)
assert.match(accessPanelSource, /blockScopeFilter[\s\S]*blockDomainFilter/u)
assert.match(accessPanelSource, /editBlock[\s\S]*scrollIntoView\(\{ behavior: "smooth"/u)
assert.match(accessPanelSource, /method: updating \? "PUT" : "POST"/u)
assert.match(mailboxBlockRouteSource, /export async function PUT/u)
assert.match(sendQuotaSource, /<SearchableUserSelect/u)
assert.match(searchableUserSource, /setTimeout\(\(\) =>/u)
assert.match(searchableUserSource, /\/api\/roles\/users\?\$\{params\}/u)
assert.match(searchableUserSource, /AbortController/u)
assert.match(domainPolicySource, /current\.inbound\.realtime\.enabled/u)
assert.match(domainPolicySource, /current\.inbound\.realtime\.reconnect/u)
assert.match(domainPolicySource, /connectionTimeoutSeconds/u)
assert.match(domainPolicySource, /idleRenewSeconds/u)
assert.match(domainPolicySource, /reconnectMinSeconds/u)
assert.match(domainPolicySource, /reconnectMaxSeconds/u)
assert.match(domainPolicySource, /imap\.capabilityIdle/u)
assert.match(domainPolicySource, /sm:grid-cols-2/u)
assert.match(domainPolicySource, /<details className="group overflow-hidden rounded border/u)
assert.match(messageListSource, /ml-auto flex min-w-0 flex-1 justify-end gap-1 overflow-x-auto whitespace-nowrap/u)
assert.match(emailListSource, /if \(!response\.ok\)[\s\S]*MAILBOXES_READ_FAILED[\s\S]*Array\.isArray\(data\.emails\)/u)
assert.match(messageListSource, /if \(!response\.ok\)[\s\S]*MESSAGES_READ_FAILED[\s\S]*Array\.isArray\(data\.messages\)/u)
assert.match(messageListSource, /max-w-48 shrink-0 truncate rounded-full/u)
assert.doesNotMatch(messageListSource, /basis-full flex flex-wrap gap-x-3/u)
assert.match(htmlFrameSource, /if \(!frame \|\| frame\.html !== html \|\| frame\.dark !== dark\)/u)
assert.match(htmlFrameSource, /srcDoc=\{frame\.source\}/u)
assert.doesNotMatch(htmlFrameSource, /srcDoc=\{source\}/u)
assert.match(messageViewSource, /relative min-h-0 flex-1 overflow-auto/u)
assert.match(sharedMessageSource, /relative min-h-0 flex-1 overflow-auto/u)
assert.ok([...threeColumnSource.matchAll(/min-h-0 flex-1 overflow-auto/gu)].length >= 5)
assert.match(appearancePanelSource, /summary className="grid min-h-14[^"]*list-none/u)
assert.match(appearancePanelSource, /\[&::-webkit-details-marker\]:hidden/u)
assert.match(appearancePanelSource, /group-open:rotate-180/u)
assert.match(appearancePanelSource, /<Tabs value=\{advancedSection\}/u)
assert.equal([...appearancePanelSource.matchAll(/<TabsTrigger value=/gu)].length, 3)
assert.match(appearancePanelSource, /xl:grid-cols-\[minmax\(0,1\.35fr\)_minmax\(18rem,.65fr\)\]/u)
assert.doesNotMatch(appearancePanelSource, /summary className="cursor-pointer select-none p-4 sm:p-5"/u)

const mailuPanelSource = readFileSync(join(process.cwd(), "app/components/profile/mailu-integration-panel.tsx"), "utf8")
assert.equal([...mailuPanelSource.matchAll(/<MailuSettingsSection\b/gu)].length, 6)
assert.match(mailuPanelSource, /type SectionId = "api" \| "accounts" \| "imap" \| "smtp" \| "retention" \| "reconcile"/u)
assert.match(mailuPanelSource, /const \[settingsExpanded, setSettingsExpanded\] = useState\(false\)/u)
assert.match(mailuPanelSource, /integration\.enabled && settingsExpanded/u)
assert.match(mailuPanelSource, /aria-expanded=\{settingsExpanded\}/u)
assert.match(mailuPanelSource, /if \(!enabled\) setSettingsExpanded\(false\)/u)
assert.match(mailuPanelSource, /role="group"/u)
assert.match(mailuPanelSource, /aria-pressed=\{activeSection === section\.id\}/u)
assert.match(mailuPanelSource, /grid-cols-2 gap-1 rounded-lg bg-muted\/50 p-1 sm:grid-cols-3 lg:grid-cols-6/u)
assert.match(mailuPanelSource, /role="region"/u)
assert.doesNotMatch(mailuPanelSource, /hidden=\{!open\}|onToggle=/u)
assert.match(mailuPanelSource, /sm:grid-cols-2 xl:grid-cols-4/u)
assert.match(mailuPanelSource, /integration\.imap\.realtime\.enabled/u)
assert.match(mailuPanelSource, /integration\.imap\.realtime\.reconnect/u)
assert.match(mailuPanelSource, /imap\.fallbackPollInterval/u)
assert.match(mailuPanelSource, /integration\.imap\.connectionTimeoutSeconds/u)
assert.match(mailuPanelSource, /integration\.imap\.realtime\.idleRenewSeconds/u)
assert.match(mailuPanelSource, /integration\.imap\.realtime\.reconnectMinSeconds/u)
assert.match(mailuPanelSource, /integration\.imap\.realtime\.reconnectMaxSeconds/u)
assert.match(mailuPanelSource, /sm:grid-cols-2 xl:grid-cols-5/u)
assert.doesNotMatch(mailuPanelSource, /<fieldset/u)

console.log(JSON.stringify({
  localePrefixHidden: true,
  legacyLocaleLinksCanonicalized: true,
  localeNavigationPreservesPath: true,
  queryAndHashPreserved: true,
  profileTabPreserved: true,
  networkNavigationRemoved: true,
  deterministicMotion: true,
  visitedProfileTabsPreserved: true,
  setupControlsPresent: true,
  authFallbackPagesLocalized: true,
  bannedSessionsSignOutWithTransientNotice: true,
  signOutPreservesCurrentBrowserOrigin: true,
  authCardStableAndResponsive: true,
  duplicateRoleIconRemoved: true,
  userRoleEditorResponsive: true,
  adaptiveUserDetailsDialog: true,
  accessPolicyLayoutCovered: true,
  allDomainMailboxBlocksLocalized: true,
  scalableMailboxBlockEditor: true,
  bidirectionalMailQuotaUiLocalized: true,
  liveQuotaCompatibilityGuidance: true,
  quotaUsageRefreshAfterSave: true,
  quotaUserSearchLiveAndAbortable: true,
  compactMailuSettingsResponsive: true,
  inlineMailboxQuotaResponsive: true,
  mailuRealtimeControlsLocalized: true,
  genericImapRealtimeControlsLocalized: true,
  imapAdvancedSettingsResponsive: true,
  htmlMessageFrameMountAndSizingGuarded: true,
  compactAdvancedAppearanceResponsive: true,
}))
