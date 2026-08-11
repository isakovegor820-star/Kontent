import { NextRequest, NextResponse } from "next/server";

import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import {
  loadStudioChatSessionForUser,
  MAX_STUDIO_CHAT_PAYLOAD_BYTES,
  parseStudioChatSaveInput,
  saveStudioChatSessionForUser,
  StudioChatPersistenceError,
} from "@/lib/studio-chat-persistence";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const stored = await loadStudioChatSessionForUser(user.id);
    return NextResponse.json({
      ok: true,
      session: stored?.payload ?? null,
      revision: stored?.revision ?? 0,
      updatedAt: stored?.updatedAt ?? null,
    });
  } catch (error) {
    console.error("[/api/studio/session GET]", { errorName: error instanceof Error ? error.name : "Error" });
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
}

export async function PUT(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const contentLength = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_STUDIO_CHAT_PAYLOAD_BYTES + 100_000) {
    return NextResponse.json({ ok: false, error: "payload_too_large" }, { status: 413 });
  }

  try {
    const input = parseStudioChatSaveInput(await req.json(), user.id);
    const result = await saveStudioChatSessionForUser(user.id, input);
    if (!result.saved) {
      return NextResponse.json({
        ok: false,
        error: "revision_conflict",
        session: result.current?.payload ?? null,
        revision: result.current?.revision ?? 0,
        updatedAt: result.current?.updatedAt ?? null,
      }, { status: 409 });
    }
    return NextResponse.json({
      ok: true,
      session: result.session.payload,
      revision: result.session.revision,
      updatedAt: result.session.updatedAt,
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
    }
    if (error instanceof StudioChatPersistenceError) {
      return NextResponse.json(
        { ok: false, error: error.code },
        { status: error.code === "payload_too_large" ? 413 : 422 },
      );
    }
    console.error("[/api/studio/session PUT]", { errorName: error instanceof Error ? error.name : "Error" });
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
}
