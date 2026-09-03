import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { hostedRobotsTxt, loadHostedSite } from "@/lib/site-hosted/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ slug: string }> };

export async function GET(_req: NextRequest, context: Context) {
  const site = await loadHostedSite(getPool(), (await context.params).slug);
  if (!site) return new NextResponse("User-agent: *\nDisallow: /\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new NextResponse(hostedRobotsTxt(site), {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}
