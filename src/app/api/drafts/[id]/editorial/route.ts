import { withProjectRoute } from "@/lib/project-route";
import { NextRequest } from "next/server";

import { getEditorialSnapshotForUser } from "@/lib/editorial-approval";
import { getSessionUser } from "@/lib/session";
import { editorialApiError, editorialJson, editorialRequestId } from "./_shared";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

async function handleGET(req: NextRequest, ctx: Context) {
  const requestId = editorialRequestId();
  const user = await getSessionUser(req);
  if (!user) return editorialJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const id = Number((await ctx.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return editorialJson({ ok: false, error: "bad_id" }, 400, requestId);
  }
  try {
    const editorial = await getEditorialSnapshotForUser(user.id, id);
    if (!editorial) return editorialJson({ ok: false, error: "not_found" }, 404, requestId);
    return editorialJson({ ok: true, editorial }, 200, requestId);
  } catch (error) {
    return editorialApiError(error, requestId);
  }
}

export const GET = withProjectRoute(handleGET);
