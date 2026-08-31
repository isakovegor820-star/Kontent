// Д.2 — «кто вошёл». Фронт зовёт при загрузке: null → лендинг, иначе → платформа.

import { NextRequest, NextResponse } from "next/server";
import {
  clearSessionCookie,
  getSessionUser,
  sessionTokenHashFromRequest,
} from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const credentialPresented = sessionTokenHashFromRequest(req) !== null;
    const user = await getSessionUser(req);
    if (user) return NextResponse.json({ user });
    if (!credentialPresented) return NextResponse.json({ user: null });

    const response = NextResponse.json(
      { user: null, error: "unauthorized" },
      { status: 401 },
    );
    clearSessionCookie(response);
    return response;
  } catch (err) {
    console.error("[/api/auth/me]", { errorName: err instanceof Error ? err.name : "Error" });
    return NextResponse.json({ user: null, error: "unavailable" }, { status: 503 });
  }
}
