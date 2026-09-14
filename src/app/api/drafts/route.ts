import { CalendarQueryError } from "@/lib/calendar-query";
import { withProjectRoute } from "@/lib/project-route";
import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/session";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { ProjectAccessError } from "@/lib/project-permissions";
import {
  createDraftForUser,
  DraftValidationError,
  listDraftPageForUser,
  parseDraftCreateInput,
} from "@/lib/server-drafts";

export const runtime = "nodejs";

async function handleGET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, ...await listDraftPageForUser(user.id, req.nextUrl.searchParams) });
  } catch (error) {
    if (error instanceof CalendarQueryError) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    if (error instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/drafts GET]", error);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}

async function handlePOST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const input = parseDraftCreateInput(await readJsonBodyValue(req));
    const result = await createDraftForUser(user.id, input);
    return NextResponse.json(
      { ok: true, draft: result.draft, created: result.created },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
    }
    if (error instanceof DraftValidationError) {
      return NextResponse.json({ ok: false, error: error.code }, { status: 422 });
    }
    if (error instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/drafts POST]", error);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}

export const GET = withProjectRoute(handleGET);
export const POST = withProjectRoute(handlePOST);
