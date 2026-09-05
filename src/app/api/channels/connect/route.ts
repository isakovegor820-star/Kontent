// Д.3 — подключение Telegram-канала. Пользователь добавил нашего бота админом
// своего канала → присылает @адрес или id → сервер проверяет, что бот реально
// имеет доступ и право публикации (getChat + getChatMember), и сохраняет канал.

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getStatsQueue } from "@/lib/queue";
import {
  ProjectAccessError,
  requireProjectPermission,
  requireSelectedProjectPermission,
} from "@/lib/project-permissions";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { createTelegramChannelProof, saveVerifiedTelegramChannel } from "@/lib/telegram-channel-connect.mjs";

import { TelegramConnectError, verifyTelegramChannelActor } from "@/lib/telegram-connect-provider.mjs";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const limit = await checkRateLimit(`telegram-connect:user:${user.id}`, 10, 60, { failureMode: "closed" });
  if (!limit.allowed) return rateLimitResponse(limit);
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

  // Принимаем @имя, ссылку t.me/имя или числовой id.
  let handle = String((body as { handle?: unknown })?.handle ?? "").trim();
  handle = handle.replace(/^https?:\/\/(t\.me|telegram\.me)\//i, "").replace(/^@/, "");
  if (!handle) {
    return NextResponse.json({ ok: false, error: "empty" }, { status: 422 });
  }
  const chatRef = /^-?\d+$/.test(handle) ? handle : `@${handle}`;

  const actor = (await pool.query<{ tg_chat_id: string | null }>(
    "select tg_chat_id from users where id = $1", [user.id],
  )).rows[0];
  const actorId = Number(actor?.tg_chat_id);
  if (!Number.isSafeInteger(actorId) || actorId <= 0) {
    return NextResponse.json({ ok: false, error: "telegram_identity_required" }, { status: 403 });
  }

  // 3. Сохраняем (или обновляем) канал пользователя.
  //
  // Канал принадлежит ровно одному проекту (частичный unique в схеме на активных).
  // Проверку делаем И запросом, И ловлей 23505: между select и insert есть окно, в которое
  // канал может занять другой аккаунт, и защитой от этой гонки может быть только база.
  try {
    const chat = await verifyTelegramChannelActor({
      token: process.env.TG_BOT_TOKEN, actorId, chatRef, signal: req.signal,
    });
    const proof = await createTelegramChannelProof(pool, { userId: user.id, projectId, chatId: chat.id, source: "web" });
    if (proof.state === "access_denied") {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    if (proof.state !== "ready" || proof.actorId !== actorId) {
      return NextResponse.json({ ok: false, error: "telegram_identity_required" }, { status: 403 });
    }
    // Provider checks can take several seconds. Recheck the captured project rather
    // than trusting a selection that may have changed in another browser tab.
    await requireProjectPermission(pool, user.id, projectId, "project.manage");
    const saved = await saveVerifiedTelegramChannel(pool, {
      userId: user.id,
      projectId,
      actorId,
      proofId: proof.proofId,
      chat: {
        ...chat,
        username: chat.username ?? handle,
      },
    });
    if (saved.state === "proof_required" || saved.state === "proof_invalid") {
      return NextResponse.json({ ok: false, error: "connection_expired" }, { status: 409 });
    }
    if (saved.state === "access_denied") {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    if (saved.state === "taken") {
      return NextResponse.json({ ok: false, error: "taken" }, { status: 409 });
    }
    const channelId = Number(saved.channelId);

    // Подключил канал — ищем соседей сразу, не дожидаясь суточного цикла. Человек идёт в
    // «Конкуренты» через минуту после подключения, и там должно быть не пусто.
    // Ищем соседей ИМЕННО ЭТОМУ каналу: у второго канала своя ниша, и обходить заодно первый
    // незачем. jobId с каналом — иначе подключение второго канала слилось бы с задачей первого.
    await getStatsQueue()
      .add(
        "discover",
        { userId: user.id, projectId, channelId },
        {
          jobId: `discover-${user.id}-${channelId}`,
          removeOnComplete: true,
          attempts: 2,
          backoff: { type: "fixed", delay: 15000 },
        },
      )
      .catch(() => {
        /* очередь недоступна — канал всё равно подключён, поиск пойдёт суточным циклом */
      });

    return NextResponse.json({ ok: true, channelId, title: chat.title });
  } catch (err) {
    if (err instanceof TelegramConnectError) {
      return NextResponse.json({ ok: false, error: err.code, retryAfter: err.retryAfter }, {
        status: err.status,
        headers: err.retryAfter ? { "Retry-After": String(err.retryAfter) } : {},
      });
    }
    if (err instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    // 23505 — канал уже держит другой аккаунт. Это не сбой сервера, а понятная ситуация,
    // и человек должен узнать причину, а не увидеть «что-то пошло не так».
    if ((err as { code?: string }).code === "23505") {
      return NextResponse.json({ ok: false, error: "taken" }, { status: 409 });
    }
    console.error("[/api/channels/connect]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
