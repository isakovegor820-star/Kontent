// Д.5 — ручной запуск сбора статистики (кнопка «Обновить»). Сбор делает воркер.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";
import { getSessionUser } from "@/lib/session";
import { getStatsQueue } from "@/lib/queue";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const membership = await requireSelectedProjectPermission(getPool(), user.id, "project.read");
    const limited = await checkRateLimit(
      `stats-collect:${membership.projectId}:${user.id}`,
      3,
      60,
    );
    if (!limited.allowed) return rateLimitResponse(limited);
    await getStatsQueue().add(
      "collect",
      // `userId` is the initiating actor; `projectId` is the data boundary.
      { userId: user.id, projectId: membership.projectId },
      {
        jobId: `stats-collect-${membership.projectId}`,
        attempts: 2,
        backoff: { type: "fixed", delay: 5000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/stats/collect]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
