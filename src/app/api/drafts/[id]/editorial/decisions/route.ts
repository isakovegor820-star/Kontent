import { NextRequest, NextResponse } from "next/server";

import {
  decideDraftEditorialRequest,
  EditorialConflictError,
  EditorialNotFoundError,
  EditorialValidationError,
  parseEditorialDecisionInput,
} from "@/lib/editorial-approval";
import { ProjectAccessError } from "@/lib/project-permissions";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Context) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const id = Number((await ctx.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: "bad_id" }, { status: 400 });
  }
  try {
    const result = await decideDraftEditorialRequest(
      user.id,
      id,
      parseEditorialDecisionInput(await req.json()),
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
    }
    if (error instanceof EditorialValidationError) {
      return NextResponse.json({ ok: false, error: error.code }, { status: 422 });
    }
    if (error instanceof EditorialNotFoundError) {
      return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    if (error instanceof EditorialConflictError) {
      return NextResponse.json({ ok: false, error: error.code }, { status: 409 });
    }
    if (error instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
    }
    console.error("[/api/drafts/:id/editorial/decisions POST]", error);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
