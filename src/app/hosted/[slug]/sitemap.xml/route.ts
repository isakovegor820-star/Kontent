import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { hostedSitemapXml, listHostedArticles, loadHostedSite } from "@/lib/site-hosted/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ slug: string }> };

export async function GET(_req: NextRequest, context: Context) {
  const pool = getPool();
  const site = await loadHostedSite(pool, (await context.params).slug);
  if (!site) return new NextResponse("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  const articles = await listHostedArticles(pool, site, 500);
  return new NextResponse(hostedSitemapXml(site, articles), {
    status: 200,
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=900" },
  });
}
