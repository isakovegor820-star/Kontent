// Д.2 — выход. Подтверждается только удаление текущей сессии в базе.

import { NextRequest, NextResponse } from "next/server";
import { destroySession } from "@/lib/session";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req, { requireBrowserOrigin: true })) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const res = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  try {
    await destroySession(req, res);
  } catch (err) {
    console.error("[/api/auth/logout]", {
      errorName: err instanceof Error ? err.name : "Error",
    });
    // Do not forward the cookie clearing staged by destroySession: retaining the
    // current credential permits an explicit retry if the DB outcome is unknown.
    return NextResponse.json({ ok: false, error: "logout_unavailable" }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
  return res;
}
