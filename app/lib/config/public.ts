/**
 * 允许下发到浏览器的运行时配置，绝不包含任何密钥。
 * 本文件会被客户端组件引用，因此不能导入任何 Node.js 模块。
 */
export interface PublicRuntimeConfig {
  baseUrl: string
  emailPollIntervalMs: number
  oauth: {
    github: boolean
    google: boolean
  }
}

export const DEFAULT_PUBLIC_RUNTIME_CONFIG: PublicRuntimeConfig = {
  baseUrl: "http://localhost:3000",
  emailPollIntervalMs: 25_000,
  oauth: { github: false, google: false },
}
