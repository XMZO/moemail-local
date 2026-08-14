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
assert.match(authSource, /signIn:\s*"\/login"/u)
assert.match(authSource, /error:\s*"\/auth-error"/u)
assert.match(authErrorSource, /<AuthErrorContent\s*\/>/u)
assert.match(authErrorContentSource, /useTranslations\("auth\.authError"\)/u)
assert.match(authErrorContentSource, /useLocale\(\)/u)

const userPanelSource = readFileSync(join(process.cwd(), "app/components/profile/promote-panel.tsx"), "utf8")
assert.doesNotMatch(userPanelSource, /<RoleIcon/u)
assert.match(userPanelSource, /sm:grid-cols-\[auto_minmax\(0,1fr\)_auto\]/u)
assert.match(userPanelSource, /<SelectTrigger className="h-8 w-full min-w-0 text-sm sm:w-auto sm:min-w-28">/u)

const accessPanelSource = readFileSync(join(process.cwd(), "app/components/profile/access-policy-panel.tsx"), "utf8")
const sendQuotaSource = readFileSync(join(process.cwd(), "app/components/profile/mail-quota-editor.tsx"), "utf8")
const searchableUserSource = readFileSync(join(process.cwd(), "app/components/profile/searchable-user-select.tsx"), "utf8")
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

console.log(JSON.stringify({
  localeNavigationPreservesPath: true,
  queryAndHashPreserved: true,
  profileTabPreserved: true,
  networkNavigationRemoved: true,
  deterministicMotion: true,
  visitedProfileTabsPreserved: true,
  setupControlsPresent: true,
  authFallbackPagesLocalized: true,
  duplicateRoleIconRemoved: true,
  userRoleEditorResponsive: true,
  accessPolicyLayoutCovered: true,
  bidirectionalMailQuotaUiLocalized: true,
  quotaUsageRefreshAfterSave: true,
  quotaUserSearchLiveAndAbortable: true,
}))
