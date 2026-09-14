import { NextRequest, NextResponse } from "next/server";
import { requireSelectedProjectPermission } from "@/lib/project-permissions";
import { resolveChannel } from "@/lib/autopilot";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { serializeTrendDataset, trendDatasetQuery } from "@/lib/trend-dataset";
import { normalizeTrendTopic, parseTrendSort, parseTrendStatPeriod, parseTrendStatSource } from "@/lib/trend-statistics";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const source = parseTrendStatSource(req.nextUrl.searchParams.get("source"));
  const period = parseTrendStatPeriod(req.nextUrl.searchParams.get("period"));
  const topic = normalizeTrendTopic(req.nextUrl.searchParams.get("topic"));
  const requestedRun = req.nextUrl.searchParams.get("run");
  const runId = requestedRun == null ? null : Number(requestedRun);
  const offset = Number(req.nextUrl.searchParams.get("offset") || 0);
  if ((runId != null && (!Number.isSafeInteger(runId) || runId <= 0))
    || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) {
    return NextResponse.json({ error: "invalid_filter" }, { status: 400 });
  }
  try {
    const pool = getPool();
    const { projectId } = await requireSelectedProjectPermission(pool, user.id, "project.read");
    let channelId: number | null = null;
    if (source !== "collection") {
      channelId = await resolveChannel({ actorUserId: user.id, projectId }, Number(req.nextUrl.searchParams.get("channel")) || null);
      if (!channelId) return NextResponse.json({ error: "no_channel" }, { status: 422 });
    }
    const input = { userId: user.id, projectId, channelId, source, period, topic, runId, offset,
      sort: parseTrendSort(req.nextUrl.searchParams.get("sort")) };
    const query = trendDatasetQuery(input);
    const result = await pool.query<{ payload: Record<string, unknown> }>(query.text, query.values);
    const payload = result.rows[0]?.payload;
    if (!payload) throw new Error("trend_dataset_missing");
    if (source === "internet" && runId && !payload.search) {
      return NextResponse.json({ error: "search_not_found" }, { status: 404 });
    }
    return NextResponse.json(serializeTrendDataset(payload, input), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    console.error("[/api/trends/stats]", error);
    return NextResponse.json({ error: "stats_unavailable" }, { status: 503 });
  }
}
