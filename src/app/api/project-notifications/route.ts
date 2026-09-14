import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import {
  authorizeProjectNotificationScope,
  listProjectNotifications,
  MAX_PROJECT_NOTIFICATION_QUERY_LENGTH,
  parseProjectNotificationListQuery,
  ProjectNotificationError,
} from "@/lib/project-notifications";
import { getSessionUser } from "@/lib/session";
import {
  projectNotificationApiError,
  projectNotificationJson,
  projectNotificationRateLimit,
} from "./_shared";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const requestId = randomUUID();
  const user = await getSessionUser(request);
  if (!user) return projectNotificationJson({ ok: false, error: "unauthorized" }, 401, requestId);
  try {
    if (request.nextUrl.search.length > MAX_PROJECT_NOTIFICATION_QUERY_LENGTH) {
      throw new ProjectNotificationError("invalid_query");
    }
    const input = parseProjectNotificationListQuery(request.nextUrl.searchParams);
    const pool = getPool();
    const scope = await authorizeProjectNotificationScope(pool, user.id);
    const limited = await projectNotificationRateLimit({
      userId: user.id,
      projectId: scope.projectId,
      kind: "read",
    });
    if (limited) return limited;
    const inbox = await listProjectNotifications(pool, scope, input);
    return projectNotificationJson({ ok: true, inbox }, 200, requestId);
  } catch (error) {
    return projectNotificationApiError(error, requestId, "list");
  }
}
