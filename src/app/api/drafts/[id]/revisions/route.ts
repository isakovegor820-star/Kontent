import { NextRequest } from "next/server";

import { listDraftRevisionHistoryForUser } from "@/lib/editorial-approval";
import { getSessionUser } from "@/lib/session";
import { editorialApiError, editorialJson, editorialRequestId } from "../editorial/_shared";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
  const requestId = editorialRequestId();
  const user = await getSessionUser(request);
  if (!user) return editorialJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const id = Number((await context.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return editorialJson({ ok: false, error: "bad_id" }, 400, requestId);
  }
  try {
    const revisions = await listDraftRevisionHistoryForUser(user.id, id);
    return editorialJson({ ok: true, revisions }, 200, requestId);
  } catch (error) {
    return editorialApiError(error, requestId);
  }
}
