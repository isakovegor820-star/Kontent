import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { listAudienceInquiries } from "@/lib/audience-assistant";
import { getSessionUser } from "@/lib/session";
import {
  audienceAssistantApiError,
  audienceAssistantJson,
} from "./_shared";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const requestId = randomUUID();
  const user = await getSessionUser(request);
  if (!user) return audienceAssistantJson({ ok: false, error: "unauthorized" }, 401, requestId);
  try {
    return audienceAssistantJson(
      { ok: true, ...(await listAudienceInquiries({ actorUserId: user.id })) },
      200,
      requestId,
    );
  } catch (error) {
    return audienceAssistantApiError(error, requestId);
  }
}
