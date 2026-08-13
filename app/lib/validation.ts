import { z } from "zod"

export const authSchema = z.object({
  username: z.string()
    .min(1, "USERNAME_REQUIRED")
    .max(20, "USERNAME_TOO_LONG")
    .regex(/^[a-zA-Z0-9_-]+$/, "USERNAME_INVALID_CHARACTERS")
    .refine(val => !val.includes('@'), "USERNAME_EMAIL_FORMAT_FORBIDDEN"),
  password: z.string()
    .min(8, "PASSWORD_TOO_SHORT")
    .max(256, "PASSWORD_TOO_LONG"),
  turnstileToken: z.string().optional()
})

export type AuthSchema = z.infer<typeof authSchema>
