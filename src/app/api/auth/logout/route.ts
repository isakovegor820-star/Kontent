// Д.2 — выход. Удаляет сессию в базе (не только cookie) — выходит везде.

import { NextRequest, NextResponse } from "next/server";
import { destroySession } from "@/lib/session";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req, { requireBrowserOrigin: true })) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const res = NextResponse.json({ ok: true });
  try {
    await destroySession(req, res);
  } catch (err) {
    console.error("[/api/auth/logout]", {
      errorName: err instanceof Error ? err.name : "Error",
    });
    // Даже если в базе не удалилось — cookie стираем, пользователь выходит.
  }
  return res;
}
