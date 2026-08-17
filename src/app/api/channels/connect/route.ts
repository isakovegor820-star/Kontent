// Д.3 — подключение Telegram-канала. Пользователь добавил нашего бота админом
// своего канала → присылает @адрес или id → сервер проверяет, что бот реально
// имеет доступ и право публикации (getChat + getChatMember), и сохраняет канал.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getStatsQueue } from "@/lib/queue";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { transitionChannelHealth } from "@/lib/channel-health.mjs";

export const runtime = "nodejs";

interface TgChat {
  id: number;
  title?: string;
  username?: string;
  type?: string;
  linked_chat_id?: number;
}

async function tg<T>(method: string, params: Record<string, string>): Promise<T | null> {
  const token = process.env.TG_BOT_TOKEN;
  if (!token) return null;
  const url = new URL(`https://api.telegram.org/bot${token}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  try {
    const r = await fetch(url, { cache: "no-store" });
    const data = (await r.json()) as { ok: boolean; result?: T };
    return data.ok ? (data.result ?? null) : null;
  } catch {
    return null;
  }
}

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

  // Принимаем @имя, ссылку t.me/имя или числовой id.
  let handle = String((body as { handle?: unknown })?.handle ?? "").trim();
  handle = handle.replace(/^https?:\/\/(t\.me|telegram\.me)\//i, "").replace(/^@/, "");
  if (!handle) {
    return NextResponse.json({ ok: false, error: "empty" }, { status: 422 });
  }
  const chatRef = /^-?\d+$/.test(handle) ? handle : `@${handle}`;

  // 1. Есть ли у бота доступ к каналу?
  const chat = await tg<TgChat>("getChat", { chat_id: chatRef });
  if (!chat) {
    return NextResponse.json({ ok: false, error: "no_access" }, { status: 422 });
  }

  // 2. Бот — админ с правом публикации?
  const botId = process.env.TG_BOT_TOKEN?.split(":")[0] ?? "";
  const member = await tg<{ status?: string; can_post_messages?: boolean }>("getChatMember", {
    chat_id: String(chat.id),
    user_id: botId,
  });
  const canPost =
    member?.status === "administrator" && member.can_post_messages !== false;
  if (!canPost) {
    return NextResponse.json({ ok: false, error: "not_admin" }, { status: 422 });
  }

  // 3. Сохраняем (или обновляем) канал пользователя.
  //
  // Канал принадлежит ровно одному аккаунту (частичный unique в схеме на активных).
  // Проверку делаем И запросом, И ловлей 23505: между select и insert есть окно, в которое
  // канал может занять другой аккаунт, и защитой от этой гонки может быть только база.
  try {
    const pool = getPool();
    const existing = await pool.query<{ id: number }>(
      `select id from channels where user_id = $1 and tg_chat_id = $2`,
      [user.id, chat.id],
    );
    if (existing.rowCount) {
      await pool.query(
        `update channels
            set title = $2, handle = $3, tg_discussion_chat_id = $4, updated_at = now()
          where id = $1`,
        [existing.rows[0].id, chat.title ?? null, chat.username ?? handle,
          Number.isSafeInteger(chat.linked_chat_id) ? chat.linked_chat_id : null],
      );
      await transitionChannelHealth(pool, {
        channelId: existing.rows[0].id,
        userId: user.id,
        actorUserId: user.id,
        status: "active",
        action: "reconnected",
      });
      return NextResponse.json({ ok: true, channelId: existing.rows[0].id, title: chat.title });
    }
    const ins = await pool.query<{ id: number }>(
      `insert into channels (user_id, network, tg_chat_id, title, handle, tg_discussion_chat_id)
       values ($1, 'tg', $2, $3, $4, $5) returning id`,
      [user.id, chat.id, chat.title ?? null, chat.username ?? handle,
        Number.isSafeInteger(chat.linked_chat_id) ? chat.linked_chat_id : null],
    );
    await pool.query(
      `insert into channel_events (channel_id, actor_user_id, action, from_status, to_status)
       values ($1, $2, 'connected', null, 'active')`,
      [ins.rows[0].id, user.id],
    );

    // Подключил канал — ищем соседей сразу, не дожидаясь суточного цикла. Человек идёт в
    // «Конкуренты» через минуту после подключения, и там должно быть не пусто.
    // Ищем соседей ИМЕННО ЭТОМУ каналу: у второго канала своя ниша, и обходить заодно первый
    // незачем. jobId с каналом — иначе подключение второго канала слилось бы с задачей первого.
    await getStatsQueue()
      .add(
        "discover",
        { userId: user.id, channelId: ins.rows[0].id },
        {
          jobId: `discover-${user.id}-${ins.rows[0].id}`,
          removeOnComplete: true,
          attempts: 2,
          backoff: { type: "fixed", delay: 15000 },
        },
      )
      .catch(() => {
        /* очередь недоступна — канал всё равно подключён, поиск пойдёт суточным циклом */
      });

    return NextResponse.json({ ok: true, channelId: ins.rows[0].id, title: chat.title });
  } catch (err) {
    // 23505 — канал уже держит другой аккаунт. Это не сбой сервера, а понятная ситуация,
    // и человек должен узнать причину, а не увидеть «что-то пошло не так».
    if ((err as { code?: string }).code === "23505") {
      return NextResponse.json({ ok: false, error: "taken" }, { status: 409 });
    }
    console.error("[/api/channels/connect]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
