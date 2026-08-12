import { NextResponse } from "next/server";

import { TRACKING_CLIENT_SOURCE } from "@/lib/tracking-client-source";

export const runtime = "nodejs";

export async function GET() {
  return new NextResponse(TRACKING_CLIENT_SOURCE, {
    status: 200,
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=300, stale-while-revalidate=3600",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "cross-origin",
      "x-content-type-options": "nosniff",
    },
  });
}
