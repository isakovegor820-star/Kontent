// Д.2 — «кто вошёл». Фронт зовёт при загрузке: null → лендинг, иначе → платформа.

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser(req);
    return NextResponse.json({ user: user ?? null });
  } catch (err) {
    console.error("[/api/auth/me]", err);
    // База недоступна — считаем, что не вошёл (покажем лендинг), но не роняем страницу.
    return NextResponse.json({ user: null });
  }
}
