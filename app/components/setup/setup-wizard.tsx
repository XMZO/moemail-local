"use client"

import { useEffect, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import type setupMessages from "@/i18n/messages/en/setup.json"
import {
  AlertTriangle,
  Check,
  Copy,
  Database,
  KeyRound,
  Loader2,
  Server,
  ShieldCheck,
  Sparkles,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

interface SetupDefaults {
  server: { baseUrl: string; trustProxyHeaders: boolean; emailPollIntervalMs: number }
  database: {
    driver: "sqlite" | "postgres"
    sqlite: { path: string }
    postgres: { url: string | null; ssl: boolean; sslRejectUnauthorized: boolean }
  }
}

interface SetupWizardProps {
  configPath: string
  setupTokenPath: string
  configInvalid: boolean
  advancedYaml: string
  advancedValuesPreserved: boolean
  defaults: SetupDefaults
}

interface SetupSuccess {
  emailIngestSecret: string
  configPath: string
  restartRequired: string | null
  adminCreated: boolean
}

interface ConfigIssue {
  path: string
  code?: string
}

type SetupDictionary = typeof setupMessages

function useSetupDictionary(): SetupDictionary {
  const translate = useTranslations("setup")
  return new Proxy({} as SetupDictionary, {
    get: (_target, key) => translate(key as keyof SetupDictionary),
  })
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Server
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-4 rounded-lg border-2 border-primary/20 bg-background p-5">
      <div className="flex items-center gap-2">
        <Icon className="h-5 w-5 text-primary" />
        <h2 className="text-base font-semibold">{title}</h2>
      </div>
      {children}
    </section>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function SetupWizard({
  configPath,
  setupTokenPath,
  configInvalid,
  advancedYaml: initialAdvancedYaml,
  advancedValuesPreserved,
  defaults,
}: SetupWizardProps) {
  const t = useSetupDictionary()
  const tApi = useTranslations("api")
  const tCommon = useTranslations("common")
  const locale = useLocale()

  const [setupToken, setSetupToken] = useState("")

  const [baseUrl, setBaseUrl] = useState(defaults.server.baseUrl)
  const [trustProxyHeaders, setTrustProxyHeaders] = useState(defaults.server.trustProxyHeaders)
  const [pollInterval, setPollInterval] = useState(String(defaults.server.emailPollIntervalMs))

  const [driver, setDriver] = useState<"sqlite" | "postgres">(defaults.database.driver)
  const [sqlitePath, setSqlitePath] = useState(defaults.database.sqlite.path)
  const [postgresUrl, setPostgresUrl] = useState(defaults.database.postgres.url ?? "")
  const [postgresSsl, setPostgresSsl] = useState(defaults.database.postgres.ssl)
  const [postgresSslStrict, setPostgresSslStrict] = useState(
    defaults.database.postgres.sslRejectUnauthorized,
  )

  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")

  const [githubClientId, setGithubClientId] = useState("")
  const [githubClientSecret, setGithubClientSecret] = useState("")
  const [googleClientId, setGoogleClientId] = useState("")
  const [googleClientSecret, setGoogleClientSecret] = useState("")
  const preservedAdvancedYaml = `# ${t.preservedAdvancedYamlComment}\n`
  const [advancedYaml, setAdvancedYaml] = useState(
    advancedValuesPreserved ? preservedAdvancedYaml : initialAdvancedYaml,
  )
  const [advancedYamlEdited, setAdvancedYamlEdited] = useState(false)

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<"ok" | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [issues, setIssues] = useState<ConfigIssue[]>([])
  const [success, setSuccess] = useState<SetupSuccess | null>(null)
  const [copied, setCopied] = useState(false)
  const [serverBack, setServerBack] = useState(true)
  const [insecurePublicHttp, setInsecurePublicHttp] = useState(false)

  useEffect(() => {
    if (typeof window === "undefined") return

    if (defaults.server.baseUrl === "http://localhost:3000") {
      setBaseUrl(window.location.origin)
    }

    const hostname = window.location.hostname.toLowerCase()
    const local = hostname === "localhost"
      || hostname === "127.0.0.1"
      || hostname === "[::1]"
      || hostname === "::1"
    setInsecurePublicHttp(window.location.protocol === "http:" && !local)
  }, [defaults.server.baseUrl])

  useEffect(() => {
    if (advancedValuesPreserved && !advancedYamlEdited) {
      setAdvancedYaml(preservedAdvancedYaml)
    }
  }, [advancedValuesPreserved, advancedYamlEdited, locale, preservedAdvancedYaml])

  // 任一会影响候选数据库连接的字段变化后，旧测试结果都不再可信。
  useEffect(() => setTestResult(null), [
    driver,
    sqlitePath,
    postgresUrl,
    postgresSsl,
    postgresSslStrict,
    advancedYaml,
  ])

  useEffect(() => {
    if (!success?.restartRequired) return
    setServerBack(false)

    let cancelled = false
    const poll = async () => {
      try {
        const response = await fetch("/api/internal/health", { cache: "no-store" })
        const body = await response.json() as { status?: string }
        if (!cancelled && response.ok && body.status === "ok") {
          setServerBack(true)
          return
        }
      } catch {
        // 重启期间请求失败是预期行为
      }
      if (!cancelled) setTimeout(poll, 2_000)
    }

    const timer = setTimeout(poll, 3_000)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [success?.restartRequired])

  const configPayload = () => ({
    server: {
      baseUrl,
      trustProxyHeaders,
      emailPollIntervalMs: pollInterval,
    },
    database: driver === "sqlite"
      ? { driver, sqlite: { path: sqlitePath } }
      : {
        driver,
        postgres: {
          ...(postgresUrl.trim() ? { url: postgresUrl.trim() } : {}),
          ssl: postgresSsl,
          sslRejectUnauthorized: postgresSslStrict,
        },
      },
    auth: {
      ...(githubClientId || githubClientSecret ? { github: {
        clientId: githubClientId || null,
        clientSecret: githubClientSecret || null,
      } } : {}),
      ...(googleClientId || googleClientSecret ? { google: {
        clientId: googleClientId || null,
        clientSecret: googleClientSecret || null,
      } } : {}),
    },
  })

  const showFailure = async (response: Response) => {
    const body = await response.json().catch(() => ({})) as {
      error?: string
      code?: string
      issues?: ConfigIssue[]
    }
    const code = body.code ?? body.error
    setError(code && tApi.has(code as never) ? tApi(code as never) : t.failed)
    setIssues(body.issues ?? [])
  }

  const handleTest = async () => {
    setTesting(true)
    setError(null)
    setIssues([])
    try {
      const response = await fetch("/api/setup/database", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-MoeMail-Setup-Token": setupToken.trim(),
        },
        body: JSON.stringify({ config: configPayload(), advancedYaml }),
      })
      if (!response.ok) {
        setTestResult(null)
        await showFailure(response)
        return
      }
      setTestResult("ok")
    } catch {
      setTestResult(null)
      setError(t.requestFailed)
    } finally {
      setTesting(false)
    }
  }

  const handleSubmit = async () => {
    setError(null)
    setIssues([])

    if (password !== confirmPassword) {
      setError(t.passwordMismatch)
      return
    }

    if (!setupToken.trim()) {
      setError(t.setupTokenHint)
      return
    }

    setSubmitting(true)
    try {
      const response = await fetch("/api/setup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-MoeMail-Setup-Token": setupToken.trim(),
        },
        body: JSON.stringify({
          config: configPayload(),
          advancedYaml,
          admin: { username, password },
        }),
      })
      if (!response.ok) {
        await showFailure(response)
        return
      }
      setSuccess(await response.json() as SetupSuccess)
      setSetupToken("")
    } catch {
      setError(t.requestFailed)
    } finally {
      setSubmitting(false)
    }
  }

  const handleCopy = async () => {
    if (!success) return
    try {
      await navigator.clipboard.writeText(success.emailIngestSecret)
      setCopied(true)
      setTimeout(() => setCopied(false), 2_000)
    } catch {
      setCopied(false)
    }
  }

  if (success) {
    return (
      <main className="mx-auto w-full max-w-2xl space-y-5 px-4 pb-10 pt-24">
        <div className="space-y-2">
          <h1 className="flex items-center gap-2 text-xl font-bold">
            <Sparkles className="h-5 w-5 text-primary" />
            {t.doneTitle}
          </h1>
          <p className="text-sm text-muted-foreground">{t.doneHint}</p>
          <p className="text-xs text-muted-foreground">
            {tCommon.rich("format.labelCodeValue", {
              label: t.configPath,
              value: success.configPath,
              code: chunks => <code className="font-mono">{chunks}</code>,
            })}
          </p>
        </div>

        <div className="space-y-2 rounded-lg border-2 border-primary/20 bg-background p-5">
          <Label className="text-sm font-medium">{t.ingestSecret}</Label>
          <div className="flex gap-2">
            <Input readOnly value={success.emailIngestSecret} className="font-mono text-xs" />
            <Button variant="outline" onClick={handleCopy}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              <span className="ml-2">{copied ? t.copied : t.copy}</span>
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t.ingestSecretHint}</p>
        </div>

        {success.restartRequired && (
          <div className="space-y-1 rounded-lg border border-dashed border-primary/40 p-4">
            <p className="text-sm font-medium">{t.restartTitle}</p>
            <p className="text-xs text-muted-foreground">{t.restartHint}</p>
          </div>
        )}

        <Button
          className="w-full"
          disabled={!serverBack}
          onClick={() => window.location.assign(`/${locale}`)}
        >
          {serverBack ? t.enter : (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t.waitingRestart}
            </>
          )}
        </Button>
      </main>
    )
  }

  return (
    <main className="mx-auto w-full max-w-2xl space-y-5 px-4 pb-10 pt-24">
      <div className="space-y-1">
        <h1 className="text-xl font-bold">{t.title}</h1>
        <p className="text-sm text-muted-foreground">{t.subtitle}</p>
        <p className="text-xs text-muted-foreground">
          {tCommon.rich("format.labelCodeValue", {
            label: t.configPath,
            value: configPath,
            code: chunks => <code className="font-mono">{chunks}</code>,
          })}
        </p>
      </div>

      {insecurePublicHttp && (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/60 bg-destructive/10 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-destructive">{t.insecureTitle}</p>
            <p className="text-xs text-muted-foreground">{t.insecureHint}</p>
          </div>
        </div>
      )}

      {configInvalid && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/60 bg-amber-500/10 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <p className="text-sm text-amber-700 dark:text-amber-300">
            {t.existingConfigInvalid}
          </p>
        </div>
      )}

      <Section icon={KeyRound} title={t.setupToken}>
        <Field label={t.setupToken} hint={t.setupTokenHint}>
          <Input
            type="password"
            value={setupToken}
            autoComplete="off"
            spellCheck={false}
            onChange={event => setSetupToken(event.target.value)}
          />
        </Field>
        <p className="text-xs text-muted-foreground">
          {tCommon.rich("format.labelCodeValue", {
            label: t.setupTokenFile,
            value: setupTokenPath,
            code: chunks => <code className="break-all font-mono">{chunks}</code>,
          })}
        </p>
      </Section>

      <Section icon={Server} title={t.siteSection}>
        <Field label={t.baseUrl} hint={t.baseUrlHint}>
          <Input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} />
        </Field>
        <Field label={t.pollInterval} hint={t.pollIntervalHint}>
          <Input
            type="number"
            min={5000}
            value={pollInterval}
            onChange={event => setPollInterval(event.target.value)}
          />
        </Field>
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="trust-proxy" className="text-sm font-medium">{t.trustProxy}</Label>
            <p className="text-xs text-muted-foreground">{t.trustProxyHint}</p>
          </div>
          <Switch
            id="trust-proxy"
            checked={trustProxyHeaders}
            onCheckedChange={setTrustProxyHeaders}
          />
        </div>
      </Section>

      <Section icon={Database} title={t.databaseSection}>
        <Field label={t.driver}>
          <Select value={driver} onValueChange={value => setDriver(value as "sqlite" | "postgres")}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="sqlite">{t.sqlite}</SelectItem>
              <SelectItem value="postgres">{t.postgres}</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {driver === "sqlite" ? (
          <Field label={t.sqlitePath} hint={t.sqlitePathHint}>
            <Input value={sqlitePath} onChange={event => setSqlitePath(event.target.value)} />
          </Field>
        ) : (
          <>
            <Field label={t.postgresUrl} hint={t.postgresUrlHint}>
              <Input
                value={postgresUrl}
                onChange={event => setPostgresUrl(event.target.value)}
                placeholder="postgres://user:password@host:5432/moemail"
              />
            </Field>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="pg-ssl" className="text-sm font-medium">{t.postgresSsl}</Label>
              <Switch id="pg-ssl" checked={postgresSsl} onCheckedChange={setPostgresSsl} />
            </div>
            {postgresSsl && (
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="pg-ssl-strict" className="text-sm font-medium">
                  {t.postgresSslStrict}
                </Label>
                <Switch
                  id="pg-ssl-strict"
                  checked={postgresSslStrict}
                  onCheckedChange={setPostgresSslStrict}
                />
              </div>
            )}
          </>
        )}

        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            onClick={handleTest}
            disabled={testing || !setupToken.trim()}
          >
            {testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {testing ? t.testing : t.testConnection}
          </Button>
          {testResult === "ok" && (
            <span className="flex items-center gap-1 text-xs text-primary">
              <Check className="h-4 w-4" />
              {t.testOk}
            </span>
          )}
        </div>
      </Section>

      <Section icon={ShieldCheck} title={t.adminSection}>
        <Field label={t.username} hint={t.adminHint}>
          <Input
            value={username}
            autoComplete="username"
            onChange={event => setUsername(event.target.value)}
          />
        </Field>
        <Field label={t.password}>
          <Input
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={event => setPassword(event.target.value)}
          />
        </Field>
        <Field label={t.confirmPassword}>
          <Input
            type="password"
            value={confirmPassword}
            autoComplete="new-password"
            onChange={event => setConfirmPassword(event.target.value)}
          />
        </Field>
      </Section>

      <details className="rounded-lg border-2 border-primary/20 bg-background p-5">
        <summary className="cursor-pointer text-base font-semibold">{t.optionalSection}</summary>
        <div className="mt-4 space-y-4">
          <p className="text-xs text-muted-foreground">{t.oauthHint}</p>
          <Field label={t.githubClientId}>
            <Input
              value={githubClientId}
              onChange={event => setGithubClientId(event.target.value)}
            />
          </Field>
          <Field label={t.githubClientSecret}>
            <Input
              type="password"
              value={githubClientSecret}
              onChange={event => setGithubClientSecret(event.target.value)}
            />
          </Field>
          <Field label={t.googleClientId}>
            <Input
              value={googleClientId}
              onChange={event => setGoogleClientId(event.target.value)}
            />
          </Field>
          <Field label={t.googleClientSecret}>
            <Input
              type="password"
              value={googleClientSecret}
              onChange={event => setGoogleClientSecret(event.target.value)}
            />
          </Field>
        </div>
      </details>

      <details className="rounded-lg border-2 border-primary/20 bg-background p-5">
        <summary className="cursor-pointer text-base font-semibold">{t.advancedSection}</summary>
        <div className="mt-4 space-y-3">
          <p className="text-xs text-muted-foreground">{t.advancedHint}</p>
          <Textarea
            value={advancedYaml}
            onChange={event => {
              setAdvancedYamlEdited(true)
              setAdvancedYaml(event.target.value)
            }}
            spellCheck={false}
            aria-label={t.advancedSection}
            className="min-h-[28rem] resize-y whitespace-pre font-mono text-xs leading-5"
          />
        </div>
      </details>

      {error && (
        <div className="space-y-1 rounded-lg border border-destructive/50 bg-destructive/10 p-4">
          <p className="text-sm font-medium text-destructive">{error}</p>
          {issues.map((issue, index) => (
            <p key={`${issue.path}-${index}`} className="text-xs text-destructive/80">
              <code className="font-mono">{issue.path}</code>
            </p>
          ))}
        </div>
      )}

      <Button
        className="w-full"
        onClick={handleSubmit}
        disabled={submitting || !setupToken.trim()}
      >
        {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {submitting ? t.submitting : t.submit}
      </Button>
    </main>
  )
}
