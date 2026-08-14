import { PERMISSIONS } from "@/lib/permissions";
import { authorizeRequest } from "@/lib/request-auth";
import { apiError } from "@/lib/api-response"
import { deleteUserAtomically } from "@/lib/user-deletion"

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
      return apiError("USER_ID_REQUIRED", 400);
    }

    if (userId === authorization.principal.userId) {
      return apiError("CANNOT_DELETE_SELF", 400);
    }

    const result = await deleteUserAtomically(userId)
    if (result === "emperor_immutable") {
      return apiError("CANNOT_DELETE_EMPEROR", 400);
    }
    if (result === "not_found") {
      return apiError("USER_NOT_FOUND", 404)
    }

    void import("@/lib/mailu/reconcile")
      .then(({ reconcileCurrentMailuIfEnabled }) => reconcileCurrentMailuIfEnabled())
      .catch(error => console.error("mailu.reconcile_after_user_delete_failed", {
        message: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      }))

    return Response.json({ success: true });
  } catch (error) {
    console.error("user.delete_failed", error);
    return apiError("USER_DELETE_FAILED", 500);
  }
}
