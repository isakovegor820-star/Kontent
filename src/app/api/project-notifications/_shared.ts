import { NextResponse } from "next/server";

import { ProjectNotificationError } from "@/lib/project-notifications";
import { ProjectAccessError } from "@/lib/project-permissions";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export function projectNotificationJson(
  body: Record<string, unknown>,
  status: number,
  requestId: string,
) {
  return NextResponse.json({ ...body, requestId }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function projectNotificationApiError(
  error: unknown,
  requestId: string,
  operation: string,
) {
  if (error instanceof ProjectAccessError) {
    return projectNotificationJson({ ok: false, error: "access_denied" }, 403, requestId);
  }
  if (error instanceof ProjectNotificationError) {
    const status = error.code === "notification_not_found" ? 404 : 422;
    return projectNotificationJson({ ok: false, error: error.code }, status, requestId);
  }
  console.error(`[project-notifications:${operation}] failed`, {
    requestId,
    errorName: error instanceof Error ? error.name : "Error",
  });
  return projectNotificationJson({ ok: false, error: "server" }, 500, requestId);
}

export function hasUnexpectedNotificationBody(request: Request): boolean {
  const contentLength = request.headers.get("content-length");
  // Node can expose a non-null request stream for a browser POST whose explicit
  // Content-Length is zero. The framing header is authoritative in that case;
  // treating the framework-created empty stream as a body breaks normal clicks.
  if (contentLength != null) return !/^\d+$/u.test(contentLength) || Number(contentLength) > 0;
  return request.body !== null;
}

export async function projectNotificationRateLimit(input: {
  userId: number;
  projectId: number;
  kind: "read" | "write";
}): Promise<NextResponse | null> {
  const userLimit = input.kind === "read" ? 720 : 240;
  const projectLimit = input.kind === "read" ? 3_600 : 1_200;
  const [userRate, projectRate] = await Promise.all([
    checkRateLimit(
      `project-notifications:${input.kind}:user:${input.userId}`,
      userLimit,
      3_600,
      { failureMode: "closed" },
    ),
    checkRateLimit(
      `project-notifications:${input.kind}:project:${input.projectId}`,
      projectLimit,
      3_600,
      { failureMode: "closed" },
    ),
  ]);
  if (!userRate.allowed) return rateLimitResponse(userRate);
  if (!projectRate.allowed) return rateLimitResponse(projectRate);
  return null;
}
