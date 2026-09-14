// Д.4 — подключение VK-сообщества. Пользователь (админ группы) создаёт в VK ключ
// доступа сообщества с правом «Стена» (Управление → Работа с API) и вставляет его сюда.
// Сервер валидирует токен (groups.getById сам определяет группу, к которой он выписан),
// ШИФРУЕТ токен (AES-GCM, привязка к user_id) и сохраняет канал network='vk'.
//
// Токен сообщества бессрочный и не требует бизнес-верификации/одобрения VK — это
// сознательно выбранная модель волны 1 (OAuth через VK ID — следующая волна, см. src/lib/vk.ts).

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import {
  ProjectAccessError,
  requireProjectPermission,
  requireSelectedProjectPermission,
} from "@/lib/project-permissions";
import { resolveGroupByToken } from "@/lib/vk";
import { encryptToken } from "@/lib/token-crypto.mjs";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { transitionChannelHealth } from "@/lib/channel-health.mjs";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const pool = getPool();
  let projectId: number;
  try {
    projectId = (await requireSelectedProjectPermission(pool, user.id, "project.manage")).projectId;
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    throw error;
  }

  let body: unknown;
  try {
    body = await readJsonBodyValue(req);
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const token = String((body as { token?: unknown })?.token ?? "").trim();
  if (!token) {
    return NextResponse.json({ ok: false, error: "empty" }, { status: 422 });
  }

  // Чувствительный роут (работа с чужими токенами): режем частые переборы по IP.
  const ip = clientIp(req);
  const byIp = await checkRateLimit(`connect-vk:ip:${ip}`, 10, 900, { failureMode: "closed" });
  if (!byIp.allowed) return rateLimitResponse(byIp);

  if (!process.env.TOKENS_MASTER_KEY) {
    console.error("[/api/channels/connect-vk] TOKENS_MASTER_KEY не задан — шифровать токен нечем");
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }

  // 1. Токен валиден и принадлежит сообществу? groups.getById без group_id возвращает
  //    группу, доступную токену, — заодно получаем название и screen_name.
  const group = await resolveGroupByToken(token);
  if (!group) {
    return NextResponse.json({ ok: false, error: "invalid_token" }, { status: 422 });
  }

  // 2. Шифруем токен с привязкой к владельцу (AAD = user_id:provider).
  const encrypted = encryptToken(token, { userId: user.id, provider: "vk" });

  // 3. Сохраняем/обновляем канал. Группа принадлежит одному аккаунту (частичный unique
  //    в схеме на активных); гонку между select и insert ловим кодом 23505, как у TG.
  try {
    await requireProjectPermission(pool, user.id, projectId, "project.manage");
    const existing = await pool.query<{ id: number }>(
      `select id from channels where project_id = $1 and vk_group_id = $2`,
      [projectId, group.groupId],
    );
    if (existing.rowCount) {
      await pool.query(
        `update channels
            set title = $2, handle = $3, vk_token = $4, updated_at = now()
          where id = $1 and project_id = $5`,
        [existing.rows[0].id, group.name || null, group.screenName || null, encrypted, projectId],
      );
      await transitionChannelHealth(pool, {
        channelId: existing.rows[0].id,
        userId: null,
        actorUserId: user.id,
        status: "active",
        action: "reconnected",
      });
      return NextResponse.json({ ok: true, channelId: existing.rows[0].id, title: group.name });
    }
    const ins = await pool.query<{ id: number }>(
      `insert into channels (project_id, user_id, network, vk_group_id, vk_token, title, handle)
       values ($1, $2, 'vk', $3, $4, $5, $6) returning id`,
      [projectId, user.id, group.groupId, encrypted, group.name || null, group.screenName || null],
    );
    await pool.query(
      `insert into channel_events (channel_id, actor_user_id, action, from_status, to_status)
       values ($1, $2, 'connected', null, 'active')`,
      [ins.rows[0].id, user.id],
    );
    return NextResponse.json({ ok: true, channelId: ins.rows[0].id, title: group.name });
  } catch (err) {
    if (err instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    if ((err as { code?: string }).code === "23505") {
      return NextResponse.json({ ok: false, error: "taken" }, { status: 409 });
    }
    console.error("[/api/channels/connect-vk]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
