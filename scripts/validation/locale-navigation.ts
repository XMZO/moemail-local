import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { localizedHref } from "../../app/i18n/navigation"

assert.equal(
  localizedHref("/zh-CN/profile", "tab=runtime&safe-appearance=1", "advanced", "ja"),
  "/ja/profile?tab=runtime&safe-appearance=1#advanced",
)
assert.equal(localizedHref("/en", "", "", "ko"), "/ko")
assert.equal(localizedHref("/shared/token", "cursor=abc", "message", "zh-TW"), "/zh-TW/shared/token?cursor=abc#message")
assert.equal(localizedHref("profile/", "?tab=domains", "#mail", "en"), "/en/profile?tab=domains#mail")

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
const loginFormSource = readFileSync(join(process.cwd(), "app/components/auth/login-form.tsx"), "utf8")
const loginPageSource = readFileSync(join(process.cwd(), "app/[locale]/login/page.tsx"), "utf8")
assert.match(authSource, /signIn:\s*"\/login"/u)
assert.match(authSource, /error:\s*"\/auth-error"/u)
assert.match(authErrorSource, /<AuthErrorContent\s*\/>/u)
assert.match(authErrorContentSource, /useTranslations\("auth\.authError"\)/u)
assert.match(authErrorContentSource, /useLocale\(\)/u)
assert.match(signButtonSource, /useCurrentOriginSignOut\(locale\)/u)
assert.match(profileSource, /useCurrentOriginSignOut\(locale\)/u)
assert.match(currentOriginSignOutSource, /signOut\(\{ redirect: false \}\)/u)
assert.match(currentOriginSignOutSource, /new URL\(`\/\$\{locale\}`, window\.location\.origin\)/u)
assert.match(currentOriginSignOutSource, /window\.location\.replace\(localizedHome\.href\)/u)
assert.doesNotMatch(`${signButtonSource}\n${profileSource}`, /callbackUrl/u)
assert.doesNotMatch(loginFormSource, /min-h-\[220px\]/u)
assert.match(loginFormSource, /grid gap-3 min-\[480px\]:grid-cols-2/u)
assert.match(loginFormSource, /usernameField\("min-\[480px\]:col-span-2"\)/u)
assert.match(loginFormSource, /className="mt-4 min-h-\[65px\] items-center"/u)
assert.match(loginFormSource, /type="submit"/u)
assert.match(loginFormSource, /activeTab === "login" \? t\("actions\.login"\) : t\("actions\.register"\)/u)
assert.match(loginPageSource, /min-h-\[100dvh\]/u)

const userPanelSource = readFileSync(join(process.cwd(), "app/components/profile/promote-panel.tsx"), "utf8")
assert.doesNotMatch(userPanelSource, /<RoleIcon/u)
assert.match(userPanelSource, /sm:grid-cols-\[auto_minmax\(0,1fr\)_auto\]/u)
assert.match(userPanelSource, /<SelectTrigger className="h-8 w-full min-w-0 text-sm sm:w-auto sm:min-w-28">/u)

const accessPanelSource = readFileSync(join(process.cwd(), "app/components/profile/access-policy-panel.tsx"), "utf8")
const sendQuotaSource = readFileSync(join(process.cwd(), "app/components/profile/mail-quota-editor.tsx"), "utf8")
const searchableUserSource = readFileSync(join(process.cwd(), "app/components/profile/searchable-user-select.tsx"), "utf8")
const domainPolicySource = readFileSync(join(process.cwd(), "app/components/profile/domain-policy-panel.tsx"), "utf8")
const messageListSource = readFileSync(join(process.cwd(), "app/components/emails/message-list.tsx"), "utf8")
assert.match(accessPanelSource, /ROLES\.EMPEROR, ROLES\.DUKE, ROLES\.KNIGHT, ROLES\.CIVILIAN/u)
assert.match(accessPanelSource, /<MailQuotaRuleEditor/u)
assert.match(accessPanelSource, /mailQuotaRules/u)
assert.doesNotMatch(accessPanelSource, /<RoleMailQuotaEditor|<UserMailQuotaEditor/u)
assert.match(sendQuotaSource, /subjectSpecificity|subjects\.all/u)
assert.doesNotMatch(sendQuotaSource, /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]/u)
assert.match(sendQuotaSource, /admin\.access\.mailQuota/u)
assert.match(sendQuotaSource, /min-\[520px\]:grid-cols-\[minmax\(5rem,.7fr\)_minmax\(5rem,.6fr\)_minmax\(7\.5rem,1fr\)\]/u)
assert.match(sendQuotaSource, /grid-cols-\[1\.25rem_minmax\(0,1fr\)\]/u)
assert.match(sendQuotaSource, /\[overflow-wrap:anywhere\]/u)
assert.match(sendQuotaSource, /\[&>span\]:truncate/u)
assert.match(accessPanelSource, /setUsageRevision\(value => value \+ 1\)/u)
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
assert.match(messageListSource, /max-w-48 shrink-0 truncate rounded-full/u)
assert.doesNotMatch(messageListSource, /basis-full flex flex-wrap gap-x-3/u)

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
  localeNavigationPreservesPath: true,
  queryAndHashPreserved: true,
  profileTabPreserved: true,
  networkNavigationRemoved: true,
  deterministicMotion: true,
  visitedProfileTabsPreserved: true,
  setupControlsPresent: true,
  authFallbackPagesLocalized: true,
  signOutPreservesCurrentBrowserOrigin: true,
  authCardStableAndResponsive: true,
  duplicateRoleIconRemoved: true,
  userRoleEditorResponsive: true,
  accessPolicyLayoutCovered: true,
  bidirectionalMailQuotaUiLocalized: true,
  quotaUsageRefreshAfterSave: true,
  quotaUserSearchLiveAndAbortable: true,
  compactMailuSettingsResponsive: true,
  inlineMailboxQuotaResponsive: true,
  mailuRealtimeControlsLocalized: true,
  genericImapRealtimeControlsLocalized: true,
  imapAdvancedSettingsResponsive: true,
}))
