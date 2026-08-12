import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getLatestTypographyRunForDraft } from "@/lib/typography-service";
import { typographyApiError, typographyJson } from "../../_shared";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const requestId = randomUUID();
  const user = await getSessionUser(request);
  if (!user) return typographyJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const draftId = Number(request.nextUrl.searchParams.get("draftId"));
  if (!Number.isSafeInteger(draftId) || draftId <= 0) {
    return typographyJson({ ok: false, error: "bad_request" }, 400, requestId);
  }
  try {
    const run = await getLatestTypographyRunForDraft({
      db: getPool(),
      actorUserId: user.id,
      draftId,
    });
    return typographyJson({ ok: true, run }, 200, requestId);
  } catch (error) {
    return typographyApiError(error, requestId);
  }
}
