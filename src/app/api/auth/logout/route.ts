// Д.2 — выход. Удаляет сессию в базе (не только cookie) — выходит везде.

import { NextRequest, NextResponse } from "next/server";
import { destroySession } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const res = NextResponse.json({ ok: true });
  try {
    await destroySession(req, res);
  } catch (err) {
    console.error("[/api/auth/logout]", err);
    // Даже если в базе не удалилось — cookie стираем, пользователь выходит.
  }
  return res;
}
