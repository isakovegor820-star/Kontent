// Д.4 — подключение VK-сообщества. Пользователь (админ группы) создаёт в VK ключ
// доступа сообщества с правом «Стена» (Управление → Работа с API) и вставляет его сюда.
// Сервер валидирует токен (groups.getById сам определяет группу, к которой он выписан),
// ШИФРУЕТ токен (AES-GCM, привязка к user_id) и сохраняет канал network='vk'.
//
// Токен сообщества бессрочный и не требует бизнес-верификации/одобрения VK — это
// сознательно выбранная модель волны 1 (OAuth через VK ID — следующая волна, см. src/lib/vk.ts).

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { resolveGroupByToken } from "@/lib/vk";
import { encryptToken } from "@/lib/token-crypto.mjs";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const token = String((body as { token?: unknown })?.token ?? "").trim();
  if (!token) {
    return NextResponse.json({ ok: false, error: "empty" }, { status: 422 });
  }

  // Чувствительный роут (работа с чужими токенами): режем частые переборы по IP.
  const ip = clientIp(req);
  const byIp = await checkRateLimit(`connect-vk:ip:${ip}`, 10, 900);
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
    const pool = getPool();
    const existing = await pool.query<{ id: number }>(
      `select id from channels where user_id = $1 and vk_group_id = $2`,
      [user.id, group.groupId],
    );
    if (existing.rowCount) {
      await pool.query(
        `update channels set title = $2, handle = $3, vk_token = $4, is_active = true where id = $1`,
        [existing.rows[0].id, group.name || null, group.screenName || null, encrypted],
      );
      return NextResponse.json({ ok: true, channelId: existing.rows[0].id, title: group.name });
    }
    const ins = await pool.query<{ id: number }>(
      `insert into channels (user_id, network, vk_group_id, vk_token, title, handle)
       values ($1, 'vk', $2, $3, $4, $5) returning id`,
      [user.id, group.groupId, encrypted, group.name || null, group.screenName || null],
    );
    return NextResponse.json({ ok: true, channelId: ins.rows[0].id, title: group.name });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return NextResponse.json({ ok: false, error: "taken" }, { status: 409 });
    }
    console.error("[/api/channels/connect-vk]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
