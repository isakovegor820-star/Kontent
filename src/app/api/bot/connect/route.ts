import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";

import {
  confirmBotConnectionSession,
  inspectBotConnectionSession,
  maskBotAccountEmail,
  normalizeTelegramBotUsername,
} from "@/lib/bot-connection.mjs";
import { getPool } from "@/lib/db";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

type ConnectBody = {
  action?: unknown;
  token?: unknown;
  allowMove?: unknown;
};

function botUsername(): string | null {
  return normalizeTelegramBotUsername(process.env.TG_BOT_USERNAME);
}

async function readBody(req: NextRequest): Promise<ConnectBody | null> {
  try {
    const value = await readJsonBodyValue(req);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as ConnectBody
      : null;
  } catch {
    return null;
  }
}

async function notifyConnectedChat(chatId: number): Promise<void> {
  const token = String(process.env.TG_BOT_TOKEN || "").trim();
  if (!token) return;
  try {
    const apiUrl = String(process.env.TG_API_URL || "https://api.telegram.org").replace(/\/+$/u, "");
    await fetch(`${apiUrl}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "Аккаунт подключён. Теперь команды и уведомления Авроры будут приходить в этот чат.",
        reply_markup: {
          inline_keyboard: [[{ text: "Проверить подключение", callback_data: "connection:status" }]],
        },
      }),
      signal: AbortSignal.timeout(4_000),
    });
  } catch (error) {
    console.warn("[/api/bot/connect] confirmation notification", {
      errorName: error instanceof Error ? error.name : "Error",
    });
  }
}

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const body = await readBody(req);
  if (!body || (body.action !== "inspect" && body.action !== "confirm")) {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  try {
    const user = await getSessionUser(req);
    const pool = getPool();
    if (body.action === "inspect") {
      const inspection = await inspectBotConnectionSession(pool, {
        token: body.token,
        userId: user?.id ?? null,
      });
      return NextResponse.json({
        ok: true,
        state: inspection.state,
        telegram: inspection.telegram
          ? {
              username: inspection.telegram.username,
              displayName: inspection.telegram.displayName,
            }
          : null,
        expiresAt: inspection.expiresAt,
        moveRequired: inspection.moveRequired === true,
        chatLinkedToAnotherAccount: inspection.chatLinkedToAnotherAccount === true,
        accountLinkedToAnotherChat: inspection.accountLinkedToAnotherChat === true,
        accountEnabled: inspection.accountEnabled !== false,
        authenticated: Boolean(user),
        account: user
          ? {
              name: user.name || null,
              email: user.email ? maskBotAccountEmail(user.email) : null,
            }
          : null,
        bot: botUsername(),
      });
    }

    if (!user) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const result = await confirmBotConnectionSession(pool, {
      token: body.token,
      userId: user.id,
      allowMove: body.allowMove === true,
    });
    if (result.state === "connected" || result.state === "already_confirmed") {
      if (result.state === "connected" && result.telegramChatId) {
        await notifyConnectedChat(result.telegramChatId);
      }
      return NextResponse.json({
        ok: true,
        state: result.state,
        moved: result.moved === true,
        bot: botUsername(),
      });
    }
    const status = result.state === "move_required"
      ? 409
      : result.state === "expired" || result.state === "revoked" || result.state === "used"
        ? 410
        : result.state === "account_disabled"
          ? 403
          : 400;
    return NextResponse.json({ ok: false, error: result.state, ...result }, { status });
  } catch (error) {
    console.error("[/api/bot/connect]", {
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
