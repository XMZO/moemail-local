import NextAuth, { CredentialsSignin } from "next-auth"
import GitHub from "next-auth/providers/github"
import Google from "next-auth/providers/google"
import { DrizzleAdapter } from "@auth/drizzle-adapter"
import { createDb, Db } from "./db"
import { accounts, users, roles, userRoles } from "./schema"
import { and, eq } from "drizzle-orm"
import { ROLES, Role } from "./permissions"
import CredentialsProvider from "next-auth/providers/credentials"
import { hashPassword, verifyPassword } from "@/lib/password"
import { authSchema, AuthSchema } from "@/lib/validation"
import { generateAvatarUrl } from "./avatar"
import { verifyTurnstileToken } from "./turnstile"
import { CONFIG_KEYS, getConfigValue } from "./config-store"
import { AuthWorkloadOverloadedError } from "./auth-abuse-guard"
import { getConfig } from "./config/runtime"

class AuthenticationTemporarilyUnavailableError extends CredentialsSignin {
  code = "temporarily_unavailable"
}

const ROLE_DESCRIPTIONS: Record<Role, string> = {
  [ROLES.EMPEROR]: "皇帝（网站所有者）",
  [ROLES.DUKE]: "公爵（超级用户）",
  [ROLES.KNIGHT]: "骑士（高级用户）",
  [ROLES.CIVILIAN]: "平民（普通用户）",
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
        description: ROLE_DESCRIPTIONS[roleName],
      })
      .returning()
    role = newRole
  }

  return role
}

export async function assignRoleToUser(db: Db, userId: string, roleId: string) {
  await db.delete(userRoles)
    .where(eq(userRoles.userId, userId))

  await db.insert(userRoles)
    .values({
      userId,
      roleId,
    })
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
  adapter: DrizzleAdapter(createDb(), {
    usersTable: users,
    accountsTable: accounts,
  }),
  providers: [
    ...oauthProviders(),
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        username: { label: "用户名", type: "text", placeholder: "请输入用户名" },
        password: { label: "密码", type: "password", placeholder: "请输入密码" },
      },
      async authorize(credentials) {
        if (!credentials) {
          throw new Error("请输入用户名和密码")
        }

        const { username, password, turnstileToken } = credentials as Record<string, string | undefined>

        let parsedCredentials: AuthSchema
        try {
          parsedCredentials = authSchema.parse({ username, password, turnstileToken })
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (error) {
          throw new Error("输入格式不正确")
        }

        const verification = await verifyTurnstileToken(parsedCredentials.turnstileToken)
        if (!verification.success) {
          if (verification.reason === "missing-token") {
            throw new Error("请先完成安全验证")
          }
          throw new Error("安全验证未通过")
        }

        const db = createDb()

        const user = await db.query.users.findFirst({
          where: eq(users.username, parsedCredentials.username),
        })

        if (!user) {
          throw new Error("用户名或密码错误")
        }

        if (!user.password) {
          throw new Error("用户名或密码错误")
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
          throw new Error("用户名或密码错误")
        }

        if (passwordVerification.needsRehash) {
          try {
            const upgradedPassword = await hashPassword(parsedCredentials.password)
            await db.update(users)
              .set({ password: upgradedPassword })
              .where(and(eq(users.id, user.id), eq(users.password, user.password)))
          } catch (error) {
            console.error("Failed to upgrade password hash:", error)
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
        await assignRoleToUser(db, user.id, role.id)
      } catch (error) {
        console.error('Error assigning role:', error)
      }
    },
  },
  callbacks: {
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
        let userRoleRecords = await db.query.userRoles.findMany({
          where: eq(userRoles.userId, session.user.id),
          with: { role: true },
        })

        if (!userRoleRecords.length) {
          const defaultRole = await getDefaultRole()
          const role = await findOrCreateRole(db, defaultRole)
          await assignRoleToUser(db, session.user.id, role.id)
          userRoleRecords = [{
            userId: session.user.id,
            roleId: role.id,
            createdAt: new Date(),
            role: role
          }]
        }

        session.user.roles = userRoleRecords.map(ur => ({
          name: ur.role.name,
        }))

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
    super("用户名已存在")
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
