// Нишевой радар: полнотекстовый поиск по постам конкурентов и трендов.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const q = req.nextUrl.searchParams.get("q")?.trim().slice(0, 200);
  if (!q) return NextResponse.json({ results: [] });

  try {
    const pool = getPool();

    // Полнотекст по competitor_posts (посты конкурентов юзера)
    const comp = await pool.query(
      `select cp.id, cp.text, cp.views, cp.reactions, cp.posted_at,
              c.title as source_title, c.handle as source_handle, 'competitor' as origin
         from competitor_posts cp
         join competitors c on c.id = cp.competitor_id and c.user_id = $1
        where cp.tsv @@ plainto_tsquery('russian', $2)
        order by ts_rank(cp.tsv, plainto_tsquery('russian', $2)) desc
        limit 30`,
      [user.id, q],
    );

    // Полнотекст по trend_posts (общие источники ниши)
    const trend = await pool.query(
      `select tp.id, tp.text, tp.views, tp.reactions, tp.posted_at,
              ts.title as source_title, ts.handle as source_handle, 'trend' as origin
         from trend_posts tp
         join trend_sources ts on ts.id = tp.source_id
        where to_tsvector('russian', coalesce(tp.text, '')) @@ plainto_tsquery('russian', $1)
        order by ts_rank(to_tsvector('russian', coalesce(tp.text, '')), plainto_tsquery('russian', $1)) desc
        limit 20`,
      [q],
    );

    const results = [...comp.rows, ...trend.rows].sort(
      (a, b) => new Date(b.posted_at ?? 0).getTime() - new Date(a.posted_at ?? 0).getTime(),
    );

    return NextResponse.json({ results: results.slice(0, 50) });
  } catch (err) {
    console.error("[/api/radar/search] GET", err);
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
}
