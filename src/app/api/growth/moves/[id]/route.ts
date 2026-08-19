import { NextRequest, NextResponse } from "next/server";

import { getGrowthMove, isGrowthAccessError, updateGrowthMoveStatus } from "@/lib/growth";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

function moveIdFrom(raw: string): number | null {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function GET(req: NextRequest, { params }: Context) {
  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const moveId = moveIdFrom((await params).id);
  if (!moveId) {
    return NextResponse.json({ error: "bad_move" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const move = await getGrowthMove({ actorUserId: user.id, moveId });
    if (!move) {
      return NextResponse.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ move }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isGrowthAccessError(error)) {
      return NextResponse.json({ error: "access_denied" }, { status: 403, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ error: "growth_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(req: NextRequest, { params }: Context) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const moveId = moveIdFrom((await params).id);
  if (!moveId) return NextResponse.json({ error: "bad_move" }, { status: 400 });
  const rate = await checkRateLimit(`growth-move:${user.id}`, 60, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);

  let body: { action?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  const status = body.action === "skip" ? "skipped" : body.action === "complete" ? "done" : null;
  if (!status) return NextResponse.json({ error: "bad_action" }, { status: 400 });

  try {
    const move = await updateGrowthMoveStatus({ actorUserId: user.id, moveId, status });
    if (!move) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ move });
  } catch (error) {
    if (isGrowthAccessError(error)) {
      return NextResponse.json({ error: "access_denied" }, { status: 403 });
    }
    return NextResponse.json({ error: "growth_unavailable" }, { status: 503 });
  }
}
