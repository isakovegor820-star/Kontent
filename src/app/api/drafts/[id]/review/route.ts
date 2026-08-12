import { NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/session";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { ProjectAccessError } from "@/lib/project-permissions";
import {
  attestDraftReviewForUser,
  DraftConflictError,
  DraftNotFoundError,
  DraftValidationError,
  parseDraftVersion,
} from "@/lib/server-drafts";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Context) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const id = Number((await ctx.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: "bad_id" }, { status: 400 });
  }

  try {
    const version = parseDraftVersion(await req.json());
    const draft = await attestDraftReviewForUser(user.id, id, version);
    return NextResponse.json({ ok: true, draft });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
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
    console.error("[/api/drafts/:id/review POST]", error);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
