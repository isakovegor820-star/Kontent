// Настройки пользователя. Пока — настроение агента для генерации (одно на аккаунт).
// GET отдаёт текущее настроение + список пресетов для интерфейса; POST сохраняет.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { MOODS, DEFAULT_MOOD, isMood } from "@/lib/moods";

export const runtime = "nodejs";

const MOOD_LIST = Object.entries(MOODS).map(([key, m]) => ({
  key,
  label: m.label,
  emoji: m.emoji,
}));

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ mood: DEFAULT_MOOD, moods: MOOD_LIST });
  try {
    const r = await getPool().query<{ ai_mood: string | null }>(
      `select ai_mood from users where id = $1`,
      [user.id],
    );
    const raw = r.rows[0]?.ai_mood;
    const mood = isMood(raw) ? raw : DEFAULT_MOOD;
    return NextResponse.json({ mood, moods: MOOD_LIST });
  } catch (err) {
    console.error("[/api/settings]", err);
    return NextResponse.json({ mood: DEFAULT_MOOD, moods: MOOD_LIST });
  }
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { mood?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  if (!isMood(body.mood)) {
    return NextResponse.json({ ok: false, error: "bad_mood" }, { status: 422 });
  }

  try {
    await getPool().query(`update users set ai_mood = $2 where id = $1`, [user.id, body.mood]);
    return NextResponse.json({ ok: true, mood: body.mood });
  } catch (err) {
    console.error("[/api/settings] POST", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
