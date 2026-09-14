import { NextRequest } from "next/server";

import {
  addDraftEditorialComment,
  parseEditorialCommentInput,
} from "@/lib/editorial-approval";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import {
  editorialApiError,
  editorialJson,
  editorialRequestId,
  readEditorialBody,
} from "../_shared";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Context) {
  if (!hasTrustedMutationOrigin(req)) {
    return editorialJson({ ok: false, error: "forbidden_origin" }, 403, editorialRequestId());
  }
  const requestId = editorialRequestId();
  const user = await getSessionUser(req);
  if (!user) return editorialJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const rate = await checkRateLimit(`editorial:comment:user:${user.id}`, 180, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);
  const id = Number((await ctx.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return editorialJson({ ok: false, error: "bad_id" }, 400, requestId);
  }
  const body = await readEditorialBody(req, ["revisionId", "contentHash", "body"]);
  if (!body) return editorialJson({ ok: false, error: "bad_request" }, 400, requestId);
  try {
    const comment = await addDraftEditorialComment(
      user.id,
      id,
      parseEditorialCommentInput(body),
    );
    return editorialJson({ ok: true, comment }, 201, requestId);
  } catch (error) {
    return editorialApiError(error, requestId);
  }
}
