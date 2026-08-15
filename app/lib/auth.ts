import NextAuth, { CredentialsSignin } from "next-auth"
import GitHub from "next-auth/providers/github"
import Google from "next-auth/providers/google"
import { DrizzleAdapter } from "@auth/drizzle-adapter"
import {
  createDb,
  type Db,
  getDatabaseDriver,
  getPostgresPool,
  getSqlite,
} from "./db"
import { accounts, users, roles, userRoles } from "./schema"
import { and, eq } from "drizzle-orm"
import { ROLES, Role } from "./permissions"
import { getEffectiveAccessPolicy } from "./access-policies"
import CredentialsProvider from "next-auth/providers/credentials"
import { hashPassword, verifyPassword } from "@/lib/password"
import { credentialsAuthSchema, CredentialsAuthSchema } from "@/lib/validation"
import { generateAvatarUrl } from "./avatar"
import { verifyTurnstileToken } from "./turnstile"
import { CONFIG_KEYS, getConfigValue } from "./config-store"
import { AuthWorkloadOverloadedError } from "./auth-abuse-guard"
import { getConfig } from "./config/runtime"
import { verifyRegistrationLoginTicket } from "./registration-login-ticket"

class AuthenticationTemporarilyUnavailableError extends CredentialsSignin {
  code = "temporarily_unavailable"
}

class UserBannedCredentialsError extends CredentialsSignin {
  code = "USER_BANNED"
}

const getDefaultRole = async (): Promise<Role> => {
  const defaultRole = await getConfigValue(CONFIG_KEYS.DEFAULT_ROLE)

  if (
    defaultRole === ROLES.DUKE ||
    defaultRole === ROLES.KNIGHT ||
    defaultRole === ROLES.CIVILIAN
  ) {
    return defaultRole as Role
  }

  return ROLES.CIVILIAN
}

async function findOrCreateRole(db: Db, roleName: Role) {
  let role = await db.query.roles.findFirst({
    where: eq(roles.name, roleName),
  })

  if (!role) {
    const [newRole] = await db.insert(roles)
      .values({
        name: roleName,
        description: null,
      })
      .returning()
    role = newRole
  }

  return role
}

export async function assignRoleToUser(
  _db: Db,
  userId: string,
  roleId: string,
  options: { preserveEmperor?: boolean; onlyIfUnassigned?: boolean } = {},
) {
  if (getDatabaseDriver() === "sqlite") {
    return getSqlite().transaction(() => {
      const target = getSqlite().prepare(`
        SELECT id FROM user WHERE id = ? LIMIT 1
      `).get(userId)
      if (!target) throw new Error("USER_NOT_FOUND")

      const current = getSqlite().prepare(`
        SELECT role.name
        FROM user_role
        INNER JOIN role ON role.id = user_role.role_id
        WHERE user_role.user_id = ?
      `).all(userId) as Array<{ name: string }>
      if (options.onlyIfUnassigned && current.length > 0) return false
      if (options.preserveEmperor && current.some(role => role.name === ROLES.EMPEROR)) {
        throw new Error("EMPEROR_ROLE_IMMUTABLE")
      }
      getSqlite().prepare("DELETE FROM user_role WHERE user_id = ?").run(userId)
      getSqlite().prepare(`
        INSERT INTO user_role (user_id, role_id, created_at) VALUES (?, ?, ?)
      `).run(userId, roleId, Date.now())
      return true
    }).immediate()
  }

  const client = await getPostgresPool().connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT pg_advisory_xact_lock(hashtext('moemail:init-emperor'))")
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`moemail:user-role:${userId}`],
    )
    const target = await client.query(
      `SELECT id FROM "user" WHERE id = $1 FOR UPDATE`,
      [userId],
    )
    if (target.rowCount !== 1) throw new Error("USER_NOT_FOUND")

    const current = await client.query<{ name: string }>(`
      SELECT role.name
      FROM user_role
      INNER JOIN role ON role.id = user_role.role_id
      WHERE user_role.user_id = $1
    `, [userId])
    if (options.onlyIfUnassigned && current.rows.length > 0) {
      await client.query("COMMIT")
      return false
    }
    if (options.preserveEmperor && current.rows.some(role => role.name === ROLES.EMPEROR)) {
      throw new Error("EMPEROR_ROLE_IMMUTABLE")
    }
    await client.query("DELETE FROM user_role WHERE user_id = $1", [userId])
    await client.query(`
      INSERT INTO user_role (user_id, role_id, created_at) VALUES ($1, $2, NOW())
    `, [userId, roleId])
    await client.query("COMMIT")
    return true
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

/** 只挂载配置文件里已填好 Client ID/Secret 的 OAuth 提供方。 */
function oauthProviders() {
  const { github, google } = getConfig().auth
  return [
    ...(github.clientId && github.clientSecret
      ? [GitHub({
        clientId: github.clientId,
        clientSecret: github.clientSecret,
        allowDangerousEmailAccountLinking: true,
      })]
      : []),
    ...(google.clientId && google.clientSecret
      ? [Google({
        clientId: google.clientId,
        clientSecret: google.clientSecret,
        allowDangerousEmailAccountLinking: true,
      })]
      : []),
  ]
}

/**
 * 配置以函数形式提供，Auth.js 每次请求都会重新求值，
 * 因此配置文件里的密钥与 OAuth 变更无需重启即可生效。
 */
export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut
} = NextAuth(() => ({
  secret: getConfig().auth.secret ?? undefined,
  // 本地部署始终位于自有反向代理之后，回调地址由请求头推导。
  trustHost: true,
  pages: {
    signIn: "/login",
    error: "/auth-error",
  },
  adapter: DrizzleAdapter(createDb(), {
    usersTable: users,
    accountsTable: accounts,
  }),
  providers: [
    ...oauthProviders(),
    CredentialsProvider({
      name: "CREDENTIALS",
      credentials: {
        username: { label: "USERNAME", type: "text", placeholder: "USERNAME" },
        password: { label: "PASSWORD", type: "password", placeholder: "PASSWORD" },
        turnstileToken: { label: "TURNSTILE_TOKEN", type: "hidden" },
        registrationTicket: { label: "REGISTRATION_TICKET", type: "hidden" },
      },
      async authorize(credentials) {
        if (!credentials) {
          throw new Error("CREDENTIALS_REQUIRED")
        }

        const {
          username,
          password,
          turnstileToken,
          registrationTicket,
        } = credentials as Record<string, string | undefined>

        let parsedCredentials: CredentialsAuthSchema
        try {
          parsedCredentials = credentialsAuthSchema.parse({
            username,
            password,
            turnstileToken,
            registrationTicket,
          })
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (error) {
          throw new Error("INVALID_CREDENTIALS_INPUT")
        }

        const registrationLogin = verifyRegistrationLoginTicket(
          parsedCredentials.registrationTicket,
          parsedCredentials.username,
        )
        if (!registrationLogin) {
          const verification = await verifyTurnstileToken(parsedCredentials.turnstileToken)
          if (!verification.success) {
            if (verification.reason === "missing-token") {
              throw new Error("TURNSTILE_REQUIRED")
            }
            throw new Error("TURNSTILE_FAILED")
          }
        }

        const db = createDb()

        const user = await db.query.users.findFirst({
          where: eq(users.username, parsedCredentials.username),
        })

        if (!user) {
          throw new Error("INVALID_CREDENTIALS")
        }

        if (registrationLogin && registrationLogin.userId !== user.id) {
          throw new Error("INVALID_CREDENTIALS")
        }

        if (!user.password) {
          throw new Error("INVALID_CREDENTIALS")
        }

        let passwordVerification
        try {
          passwordVerification = await verifyPassword(
            parsedCredentials.password,
            user.password,
          )
        } catch (error) {
          if (error instanceof AuthWorkloadOverloadedError) {
            throw new AuthenticationTemporarilyUnavailableError()
          }
          throw error
        }
        if (!passwordVerification.valid) {
          throw new Error("INVALID_CREDENTIALS")
        }

        if (user.bannedAt) {
          // Only reveal the ban after a valid password, so the status cannot
          // be used to enumerate accounts through the login form.
          throw new UserBannedCredentialsError()
        }

        if (passwordVerification.needsRehash) {
          try {
            const upgradedPassword = await hashPassword(parsedCredentials.password)
            await db.update(users)
              .set({ password: upgradedPassword })
              .where(and(eq(users.id, user.id), eq(users.password, user.password)))
          } catch (error) {
            console.error("auth.password_hash_upgrade_failed", error)
          }
        }

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          emailVerified: user.emailVerified,
          image: user.image,
          username: user.username,
        }
      },
    }),
  ],
  events: {
    async signIn({ user }) {
      if (!user.id) return

      try {
        const db = createDb()
        const existingRole = await db.query.userRoles.findFirst({
          where: eq(userRoles.userId, user.id),
        })

        if (existingRole) return

        const defaultRole = await getDefaultRole()
        const role = await findOrCreateRole(db, defaultRole)
        await assignRoleToUser(db, user.id, role.id, { onlyIfUnassigned: true })
      } catch (error) {
        console.error("auth.role_assignment_failed", error)
      }
    },
  },
  callbacks: {
    async signIn({ user }) {
      if (!user.id) return false
      try {
        const target = await createDb().query.users.findFirst({
          where: eq(users.id, user.id),
          columns: { bannedAt: true },
        })
        return Boolean(target && !target.bannedAt)
      } catch (error) {
        console.error("auth.banned_status_check_failed", {
          name: error instanceof Error ? error.name : "UnknownError",
        })
        return false
      }
    },
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id
        token.name = user.name || user.username
        token.username = user.username
        token.image = user.image || generateAvatarUrl(token.name as string)
      }
      return token
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id as string
        session.user.name = token.name as string
        session.user.username = token.username as string
        session.user.image = token.image as string

        const db = createDb()
        const targetUser = await db.query.users.findFirst({
          where: eq(users.id, session.user.id),
          columns: { bannedAt: true },
        })
        session.user.bannedAt = targetUser?.bannedAt ?? null
        if (targetUser?.bannedAt) return session

        let userRoleRecords = await db.query.userRoles.findMany({
          where: eq(userRoles.userId, session.user.id),
          with: { role: true },
        })

        if (!userRoleRecords.length) {
          const defaultRole = await getDefaultRole()
          const role = await findOrCreateRole(db, defaultRole)
          await assignRoleToUser(db, session.user.id, role.id, { onlyIfUnassigned: true })
          userRoleRecords = await db.query.userRoles.findMany({
            where: eq(userRoles.userId, session.user.id),
            with: { role: true },
          })
        }

        session.user.roles = userRoleRecords.map(ur => ({
          name: ur.role.name,
        }))

        const normalizedRoles = session.user.roles.map(role => role.name as Role)
        const access = await getEffectiveAccessPolicy(session.user.id, normalizedRoles)
        session.user.permissions = Object.entries(access.permissions)
          .filter(([, enabled]) => enabled)
          .map(([permission]) => permission)
        session.user.quotas = access.quotas
        session.user.allowedDomains = access.allowedDomains

        const userAccounts = await db.query.accounts.findMany({
          where: eq(accounts.userId, session.user.id),
        })

        session.user.providers = userAccounts.map(account => account.provider)
      }

      return session
    },
  },
  session: {
    strategy: "jwt",
  },
}))

export class UsernameAlreadyExistsError extends Error {
  constructor() {
    super("USERNAME_ALREADY_EXISTS")
    this.name = "UsernameAlreadyExistsError"
  }
}

function isUniqueConstraintError(error: unknown) {
  let current = error
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === "object") {
      const candidate = current as { code?: unknown; cause?: unknown }
      if (
        candidate.code === "23505"
        || candidate.code === "SQLITE_CONSTRAINT_UNIQUE"
        || candidate.code === "SQLITE_CONSTRAINT_PRIMARYKEY"
      ) {
        return true
      }
      current = candidate.cause
    } else {
      break
    }
  }
  return false
}

export async function register(username: string, password: string) {
  const db = createDb()

  const existing = await db.query.users.findFirst({
    where: eq(users.username, username)
  })

  if (existing) {
    throw new UsernameAlreadyExistsError()
  }

  const hashedPassword = await hashPassword(password)

  try {
    const [user] = await db.insert(users)
      .values({
        username,
        password: hashedPassword,
      })
      .returning()

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      image: user.image,
      username: user.username,
    }
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new UsernameAlreadyExistsError()
    }
    throw error
  }
}
