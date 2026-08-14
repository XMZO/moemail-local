import { z } from "zod"
import type { MailuIntegration } from "./config"

const domainSchema = z.object({
  name: z.string().trim().toLowerCase().min(1).max(253),
  comment: z.string().nullable().optional(),
  max_users: z.number().int().optional(),
  max_aliases: z.number().int().optional(),
})

const userSchema = z.object({
  email: z.string().trim().toLowerCase().min(3).max(320),
  comment: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  enable_imap: z.boolean().optional(),
  enable_pop: z.boolean().optional(),
  allow_spoofing: z.boolean().optional(),
  forward_enabled: z.boolean().optional(),
  forward_destination: z.array(z.string().trim().toLowerCase().min(3).max(320)).optional(),
  forward_keep: z.boolean().optional(),
})

const aliasSchema = z.object({
  email: z.string().trim().toLowerCase().min(3).max(320),
  destination: z.array(z.string().trim().toLowerCase().min(3).max(320)),
  comment: z.string().nullable().optional(),
  wildcard: z.boolean().optional().default(false),
  disabled: z.boolean().optional().default(false),
})

const responseSchema = z.object({
  code: z.number().int().optional(),
  message: z.string().optional(),
})

export type MailuDomain = z.output<typeof domainSchema>
export type MailuUser = z.output<typeof userSchema>
export type MailuAlias = z.output<typeof aliasSchema>

export class MailuApiError extends Error {
  constructor(readonly operation: string, readonly status: number) {
    super(`MAILU_API_FAILED:${operation}:${status}`)
    this.name = "MailuApiError"
  }
}

export class MailuClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly timeoutMs: number

  constructor(integration: Pick<MailuIntegration, "api">) {
    this.baseUrl = integration.api.baseUrl
    this.token = integration.api.token
    this.timeoutMs = integration.api.timeoutSeconds * 1_000
  }

  private url(path: string) {
    return `${this.baseUrl}${path}`
  }

  private async responseText(operation: string, response: Response) {
    const maximum = 10 * 1024 * 1024
    const declared = response.headers.get("content-length")
    if (declared && Number(declared) > maximum) throw new MailuApiError(operation, 502)
    if (!response.body) return ""

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maximum) {
          await reader.cancel().catch(() => undefined)
          throw new MailuApiError(operation, 502)
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf8")
  }

  private async request<T extends z.ZodTypeAny>(operation: string, path: string, schema: T, init: RequestInit = {}): Promise<z.output<T>> {
    let response: Response
    try {
      response = await fetch(this.url(path), {
        ...init,
        redirect: "manual",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch {
      throw new MailuApiError(operation, 502)
    }
    if (response.status >= 300 && response.status < 400) {
      throw new MailuApiError(operation, response.status)
    }
    if (!response.ok) throw new MailuApiError(operation, response.status)
    const text = await this.responseText(operation, response)
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : {}
    } catch {
      throw new MailuApiError(operation, 502)
    }
    const validated = schema.safeParse(parsed)
    if (!validated.success) throw new MailuApiError(operation, 502)
    return validated.data as z.output<T>
  }

  listInventory() {
    return Promise.all([this.listDomains(), this.listUsers(), this.listAliases()])
      .then(([domains, users, aliases]) => ({ domains, users, aliases }))
  }

  listDomains() {
    return this.request("list-domains", "/domain", z.array(domainSchema))
  }

  listUsers() {
    return this.request("list-users", "/user", z.array(userSchema))
  }

  getUser(email: string) {
    return this.request("get-user", `/user/${this.emailPath(email)}`, userSchema)
  }

  createUser(input: {
    email: string
    raw_password: string
    comment: string
    enabled: boolean
    enable_imap: boolean
    enable_pop: boolean
    allow_spoofing: boolean
    forward_enabled?: boolean
    forward_destination?: string[]
    forward_keep?: boolean
  }) {
    return this.request("create-user", "/user", responseSchema, {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  updateUser(email: string, input: Record<string, unknown>) {
    return this.request("update-user", `/user/${this.emailPath(email)}`, responseSchema, {
      method: "PATCH",
      body: JSON.stringify(input),
    })
  }

  listAliases() {
    return this.request("list-aliases", "/alias", z.array(aliasSchema))
  }

  getAlias(email: string) {
    return this.request("get-alias", `/alias/${this.emailPath(email)}`, aliasSchema)
  }

  createAlias(input: { email: string; destination: string[]; comment: string; wildcard: boolean }) {
    return this.request("create-alias", "/alias", responseSchema, {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  updateAlias(email: string, input: { destination: string[]; comment: string; wildcard: boolean }) {
    return this.request("update-alias", `/alias/${this.emailPath(email)}`, responseSchema, {
      method: "PATCH",
      body: JSON.stringify(input),
    })
  }

  deleteAlias(email: string) {
    return this.request("delete-alias", `/alias/${this.emailPath(email)}`, responseSchema, {
      method: "DELETE",
    })
  }

  private emailPath(value: string) {
    // Flask routes decode each path segment before matching. Encoding '@' is
    // unnecessary, while slashes (possible only in a quoted local-part, which
    // MoeMail rejects) must never create an extra path segment.
    return encodeURIComponent(value).replaceAll("%40", "@")
  }
}
