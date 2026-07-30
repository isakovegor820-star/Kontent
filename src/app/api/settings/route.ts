// Настройки пользователя. Настроение — связка из 1–3 редакторских профилей на аккаунт.
// В БД хранится JSON-массив; старые одиночные ключи продолжаем читать без миграции.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import {
  MOODS,
  DEFAULT_MOOD,
  isMoodSelection,
  normalizeMoodSelection,
} from "@/lib/moods";

export const runtime = "nodejs";

const MOOD_LIST = Object.entries(MOODS).map(([key, m]) => ({
  key,
  label: m.label,
  emoji: m.emoji,
  description: m.description,
}));

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ mood: [DEFAULT_MOOD], moods: MOOD_LIST });
  try {
    const r = await getPool().query<{ ai_mood: string | null }>(
      `select ai_mood from users where id = $1`,
      [user.id],
    );
    const raw = r.rows[0]?.ai_mood;
    const mood = normalizeMoodSelection(raw);
    return NextResponse.json({ mood, moods: MOOD_LIST });
  } catch (err) {
    console.error("[/api/settings]", err);
    return NextResponse.json({ mood: [DEFAULT_MOOD], moods: MOOD_LIST });
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
  if (!isMoodSelection(body.mood)) {
    return NextResponse.json({ ok: false, error: "bad_mood" }, { status: 422 });
  }

  try {
    const mood = normalizeMoodSelection(body.mood);
    await getPool().query(`update users set ai_mood = $2 where id = $1`, [user.id, JSON.stringify(mood)]);
    return NextResponse.json({ ok: true, mood });
  } catch (err) {
    console.error("[/api/settings] POST", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
