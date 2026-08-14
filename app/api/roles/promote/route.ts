import { createDb } from "@/lib/db";
import { roles } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { PERMISSIONS, ROLES } from "@/lib/permissions";
import { assignRoleToUser } from "@/lib/auth";
import { authorizeRequest } from "@/lib/request-auth";
import { apiError } from "@/lib/api-response";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.PROMOTE_USER,
  });
  if (!authorization.ok) return authorization.response;

  try {
    const { userId, roleName } = await request.json() as { 
      userId: string, 
      roleName: typeof ROLES.DUKE | typeof ROLES.KNIGHT | typeof ROLES.CIVILIAN 
    };
    if (!userId || !roleName) {
      return apiError("REQUIRED_PARAMETERS_MISSING", 400);
    }

    if (![ROLES.DUKE, ROLES.KNIGHT, ROLES.CIVILIAN].includes(roleName)) {
      return apiError("INVALID_ROLE", 400);
    }

    const db = createDb();

    let targetRole = await db.query.roles.findFirst({
      where: eq(roles.name, roleName),
    });

    if (!targetRole) {
      const [newRole] = await db.insert(roles)
        .values({
          name: roleName,
          description: null,
        })
        .returning();
      targetRole = newRole;
    }

    await assignRoleToUser(db, userId, targetRole.id, { preserveEmperor: true });

    void import("@/lib/mailu/reconcile")
      .then(({ reconcileCurrentMailuIfEnabled }) => reconcileCurrentMailuIfEnabled())
      .catch(error => console.error("mailu.reconcile_after_role_change_failed", {
        message: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      }))

    return Response.json({ 
      success: true,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "USER_NOT_FOUND") {
      return apiError("USER_NOT_FOUND", 404);
    }
    if (error instanceof Error && error.message === "EMPEROR_ROLE_IMMUTABLE") {
      return apiError("EMPEROR_ROLE_IMMUTABLE", 400);
    }
    console.error("role.assignment_failed", error);
    return apiError("ROLE_UPDATE_FAILED", 500);
  }
}
