import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  try {
    const user = await getSessionUser(req);
    if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

    const result = await getPool().query<{ onboarding_completed_at: string }>(
      `update users
          set onboarding_completed_at = coalesce(onboarding_completed_at, now())
        where id = $1
        returning onboarding_completed_at`,
      [user.id],
    );
    if (!result.rows[0]) {
      return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({
      ok: true,
      onboardingCompletedAt: result.rows[0].onboarding_completed_at,
    });
  } catch (error) {
    console.error("[/api/onboarding/complete]", {
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
}
