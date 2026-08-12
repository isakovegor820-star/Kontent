import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import {
  authorizeProjectNotificationScope,
  markAllProjectNotificationsRead,
} from "@/lib/project-notifications";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import {
  hasUnexpectedNotificationBody,
  projectNotificationApiError,
  projectNotificationJson,
  projectNotificationRateLimit,
} from "../_shared";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(request)) {
    return projectNotificationJson({ ok: false, error: "forbidden_origin" }, 403, requestId);
  }
  const user = await getSessionUser(request);
  if (!user) return projectNotificationJson({ ok: false, error: "unauthorized" }, 401, requestId);
  try {
    if (hasUnexpectedNotificationBody(request)) {
      return projectNotificationJson({ ok: false, error: "unexpected_body" }, 400, requestId);
    }
    const pool = getPool();
    const scope = await authorizeProjectNotificationScope(pool, user.id);
    const limited = await projectNotificationRateLimit({
      userId: user.id,
      projectId: scope.projectId,
      kind: "write",
    });
    if (limited) return limited;
    const result = await markAllProjectNotificationsRead(pool, scope);
    return projectNotificationJson({ ok: true, ...result }, 200, requestId);
  } catch (error) {
    return projectNotificationApiError(error, requestId, "mark-all");
  }
}
