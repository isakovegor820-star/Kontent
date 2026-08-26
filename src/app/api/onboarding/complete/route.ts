import { NextRequest, NextResponse } from "next/server";

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { completeOnboarding, OnboardingProgressError } from "@/lib/onboarding-progress";
import { ProjectAccessError } from "@/lib/project-permissions";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  try {
    const user = await getSessionUser(req);
    if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

    const body = await readJsonBodyValue(req);
    if (!isRecord(body) || Object.keys(body).some((key) => !["channelId", "draftId"].includes(key))) {
      return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
    }
    const channelId = Number(body.channelId);
    const draftId = Number(body.draftId);
    if (!Number.isSafeInteger(channelId) || channelId <= 0
        || !Number.isSafeInteger(draftId) || draftId <= 0) {
      return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
    }
    const result = await completeOnboarding({ userId: user.id, channelId, draftId });
    return NextResponse.json({
      ok: true,
      onboardingCompletedAt: result.onboardingCompletedAt,
      progress: result.progress,
    });
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError) {
      return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
    }
    if (error instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    if (error instanceof OnboardingProgressError) {
      return NextResponse.json({ ok: false, error: error.code }, { status: 409 });
    }
    console.error("[/api/onboarding/complete]", {
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
}
