// Ручной запуск сбора RSS-лент: кнопка «Проверить сейчас» на экране RSS.
// Крон и так проверяет каждые 30 минут — здесь человеку даём контроль «прямо сейчас».
// jobId по юзеру: частые клики не плодят задачи, а сливаются в одну (паттерн /api/trends).

import { readJsonBodyValue } from "@/lib/bounded-request-body";
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

  let body: { channelId?: unknown } = {};
  try {
    body = await readJsonBodyValue(req);
  } catch {
    // Старые клиенты могли отправлять пустой body — ниже используем все ленты.
  }
  const channelId = body.channelId == null ? null : Number(body.channelId);
  if(channelId!==null&&(!Number.isSafeInteger(channelId)||channelId<=0))return NextResponse.json({ok:false,error:"bad_channel"},{status:422});

  try {
    const membership=await requireSelectedProjectPermission(getPool(),user.id,"content.create");
    if (channelId) {
      const channel = await getPool().query(
        `select id from channels
          where id = $1 and project_id = $2 and is_active and status='active' and network in ('tg', 'vk')`,
        [channelId, membership.projectId],
      );
      if (!channel.rowCount) {
        return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });
      }
    }
    await getStatsQueue().add(
      "rss-now",
      { userId: user.id, channelId, projectId: membership.projectId },
      {
        jobId: `rss-now-${user.id}-${membership.projectId}-${channelId ?? "all"}`,
        removeOnComplete: true,
        removeOnFail: true,
        attempts: 2,
        backoff: { type: "fixed", delay: 15000 },
      },
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    if(err instanceof ProjectAccessError)return NextResponse.json({ok:false,error:"access_denied"},{status:403});
    console.error("[/api/rss/refresh] POST", {errorName:err instanceof Error?err.name:"Error"});
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
