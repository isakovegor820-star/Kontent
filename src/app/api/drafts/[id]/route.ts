import { NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/session";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import {
  deleteDraftForUser,
  DraftConflictError,
  DraftNotFoundError,
  DraftValidationError,
  getDraftForUser,
  parseDraftUpdateInput,
  parseDraftVersion,
  updateDraftForUser,
} from "@/lib/server-drafts";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

async function draftId(ctx: Context): Promise<number | null> {
  const id = Number((await ctx.params).id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function knownError(error: unknown): NextResponse | null {
  if (error instanceof SyntaxError) {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  if (error instanceof DraftValidationError) {
    return NextResponse.json({ ok: false, error: error.code }, { status: 422 });
  }
  if (error instanceof DraftNotFoundError) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (error instanceof DraftConflictError) {
    return NextResponse.json(
      { ok: false, error: "version_conflict", current: error.current },
      { status: 409 },
    );
  }
  return null;
}

export async function GET(req: NextRequest, ctx: Context) {
  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const id = await draftId(ctx);
  if (id == null) {
    return NextResponse.json({ ok: false, error: "bad_id" }, { status: 400 });
  }
  try {
    const draft = await getDraftForUser(user.id, id);
    if (!draft) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, draft });
  } catch (error) {
    console.error("[/api/drafts/:id GET]", error);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, ctx: Context) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const id = await draftId(ctx);
  if (id == null) {
    return NextResponse.json({ ok: false, error: "bad_id" }, { status: 400 });
  }
  try {
    const draft = await updateDraftForUser(user.id, id, parseDraftUpdateInput(await req.json()));
    return NextResponse.json({ ok: true, draft });
  } catch (error) {
    const response = knownError(error);
    if (response) return response;
    console.error("[/api/drafts/:id PATCH]", error);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, ctx: Context) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const id = await draftId(ctx);
  if (id == null) {
    return NextResponse.json({ ok: false, error: "bad_id" }, { status: 400 });
  }
  try {
    await deleteDraftForUser(user.id, id, parseDraftVersion(await req.json()));
    return NextResponse.json({ ok: true });
  } catch (error) {
    const response = knownError(error);
    if (response) return response;
    console.error("[/api/drafts/:id DELETE]", error);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
