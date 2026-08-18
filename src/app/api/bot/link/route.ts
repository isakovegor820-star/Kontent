// Привязка бота к аккаунту. Кабинет просит ссылку — отдаём t.me/<bot>?start=<код>.
// Бот по коду поймёт, КТО ему написал, и запомнит чат: дальше уведомления идут этому
// человеку, а не в общий TG_CHAT_ID владельца.
//
// Код одноразовый и живёт 15 минут — это ключ от чужих уведомлений и кнопки «Одобрить всё»,
// которая публикует посты в живой канал. Валяться такому нельзя.

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { probeRedisAndPublicationWorker } from "@/lib/readiness-probes";

export const runtime = "nodejs";

const LINK_TTL_MIN = 15;

/** Имя бота из токена не достать — берём из env, иначе ссылку не собрать. */
function botUsername(): string | null {
  return process.env.TG_BOT_USERNAME || null;
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const [result, runtime] = await Promise.all([
      getPool().query<{ tg_chat_id: string | null }>(
        `select tg_chat_id from users where id = $1`,
        [user.id],
      ),
      probeRedisAndPublicationWorker(),
    ]);
    const row = result.rows[0];
    return NextResponse.json({
      linked: !!row?.tg_chat_id,
      bot: botUsername(),
      botStatus: runtime.telegramPolling,
    });
  } catch (err) {
    console.error("[/api/bot/link] GET", err);
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
}

/** Выдать свежую ссылку привязки. */
export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const bot = botUsername();
  if (!bot) {
    // Честно: без имени бота ссылку не собрать. Не выдумываем и не показываем битую.
    return NextResponse.json(
      { ok: false, error: "bot_not_configured", needs: "TG_BOT_USERNAME" },
      { status: 503 },
    );
  }

  try {
    const pool = getPool();
    // Старые коды этого человека гасим: активный код должен быть один.
    await pool.query(`delete from bot_links where user_id = $1 and used_at is null`, [user.id]);

    const code = randomBytes(16).toString("hex");
    await pool.query(
      `insert into bot_links (code, user_id, expires_at)
       values ($1, $2, now() + make_interval(mins => $3))`,
      [code, user.id, LINK_TTL_MIN],
    );

    return NextResponse.json({
      ok: true,
      url: `https://t.me/${bot}?start=${code}`,
      expiresInMin: LINK_TTL_MIN,
    });
  } catch (err) {
    console.error("[/api/bot/link] POST", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}

/** Отвязать: бот перестаёт писать. */
export async function DELETE(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    await getPool().query(`update users set tg_chat_id = null where id = $1`, [user.id]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/bot/link] DELETE", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
