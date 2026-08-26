import { NextRequest, NextResponse } from "next/server";

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import {
  getOnboardingProgress,
  OnboardingProgressError,
  saveOnboardingProgress,
} from "@/lib/onboarding-progress";
import { ProjectAccessError } from "@/lib/project-permissions";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, progress: await getOnboardingProgress(user.id) });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/onboarding/progress GET]", { errorName: error instanceof Error ? error.name : "Error" });
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
}

export async function PATCH(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const body = await readJsonBodyValue(req);
    if (!isRecord(body) || Object.keys(body).some((key) => !["step", "channelId", "skippedFirstSource"].includes(key))) {
      return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
    }
    const step = Number(body.step);
    const channelId = body.channelId == null ? null : Number(body.channelId);
    if (!Number.isSafeInteger(step) || step < 1 || step > 5
        || (channelId != null && (!Number.isSafeInteger(channelId) || channelId <= 0))
        || (body.skippedFirstSource != null && typeof body.skippedFirstSource !== "boolean")) {
      return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
    }
    const progress = await saveOnboardingProgress({
      userId: user.id,
      step,
      channelId,
      skippedFirstSource: body.skippedFirstSource === true,
    });
    return NextResponse.json({ ok: true, progress });
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
    console.error("[/api/onboarding/progress PATCH]", { errorName: error instanceof Error ? error.name : "Error" });
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
}
