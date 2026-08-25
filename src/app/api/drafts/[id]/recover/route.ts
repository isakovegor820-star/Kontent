import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/session";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { ProjectAccessError } from "@/lib/project-permissions";
import {
  DraftConflictError,
  DraftNotFoundError,
  DraftValidationError,
  parseDraftRecoveryInput,
  recoverDraftForUser,
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
  const sourceDraftId = Number((await ctx.params).id);
  if (!Number.isSafeInteger(sourceDraftId) || sourceDraftId <= 0) {
    return NextResponse.json({ ok: false, error: "bad_id" }, { status: 400 });
  }

  try {
    const result = await recoverDraftForUser(
      user.id,
      sourceDraftId,
      parseDraftRecoveryInput(await readJsonBodyValue(req)),
    );
    return NextResponse.json(
      { ok: true, draft: result.draft, created: result.created },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
    }
    if (error instanceof DraftConflictError) {
      return NextResponse.json(
        { ok: false, error: "version_conflict", current: error.current },
        { status: 409 },
      );
    }
    if (error instanceof DraftNotFoundError) {
      return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    if (error instanceof DraftValidationError) {
      return NextResponse.json({ ok: false, error: error.code }, { status: 422 });
    }
    if (error instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/drafts/:id/recover POST]", error);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
