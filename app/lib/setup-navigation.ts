import { redirect } from "next/navigation"
import { isSetupCompleted } from "./config/runtime"

/** 在任何会触碰认证或数据库之前，把未初始化实例导向 WebUI 向导。 */
export function requireCompletedSetup(locale: string) {
  if (!isSetupCompleted()) {
    redirect(`/${locale}/setup`)
  }
}
