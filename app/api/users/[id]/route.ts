import { createDb } from "@/lib/db";
import { users, userRoles, apiKeys } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { ROLES, PERMISSIONS } from "@/lib/permissions";
import { authorizeRequest } from "@/lib/request-auth";
import { getAccessPolicies, saveAccessPolicies } from "@/lib/access-policies"

export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.PROMOTE_USER,
  });
  if (!authorization.ok) return authorization.response;

  try {
    const { id: userId } = await params;
    if (!userId) {
      return Response.json({ error: "缺少必要参数" }, { status: 400 });
    }

    if (userId === authorization.principal.userId) {
      return Response.json({ error: "不能删除自己" }, { status: 400 });
    }

    const db = createDb();

    const targetUserRoles = await db.query.userRoles.findMany({
      where: eq(userRoles.userId, userId),
      with: {
        role: true,
      },
    });

    if (targetUserRoles.some(item => item.role.name === ROLES.EMPEROR)) {
      return Response.json({ error: "不能删除皇帝" }, { status: 400 });
    }

    // apiKeys 未配置级联删除，需先手动删除；其余（accounts / emails→messages / webhooks / userRoles）由外键级联处理
    await db.delete(apiKeys).where(eq(apiKeys.userId, userId));
    await db.delete(users).where(eq(users.id, userId));

    try {
      const policies = await getAccessPolicies()
      if (policies.users[userId]) {
        delete policies.users[userId]
        await saveAccessPolicies(policies)
      }
    } catch (cleanupError) {
      console.error("Failed to remove deleted user's access override:", cleanupError)
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error("Failed to delete user:", error);
    return Response.json({ error: "操作失败" }, { status: 500 });
  }
}
