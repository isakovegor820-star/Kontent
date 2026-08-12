// Д.5 — отправить недельный отчёт в Telegram-бот сейчас (обычно раз в неделю сам).

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";
import { getSessionUser } from "@/lib/session";
import { getStatsQueue } from "@/lib/queue";
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
    // attempts+backoff: если доставка сорвётся (воркер бросит ошибку), очередь повторит
    // отчёт через паузу — уведомление не теряется молча.
    await getStatsQueue().add(
      "report",
      // `userId` identifies the report recipient; `projectId` scopes its data.
      { userId: user.id, projectId: membership.projectId },
      {
        jobId: `report-${membership.projectId}-${user.id}`,
        removeOnComplete: true,
        removeOnFail: true,
        attempts: 3,
        backoff: { type: "fixed", delay: 30000 },
      },
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/stats/report]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
