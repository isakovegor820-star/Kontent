import { NextRequest, NextResponse } from "next/server";

import { navyMediaCapabilities } from "@/lib/navy-media.mjs";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (process.env.MEDIA_GENERATION_ENABLED === "false") {
    return NextResponse.json({ configured: true, enabled: false, checked: true, plan: null, models: [] });
  }

  const capabilities = await navyMediaCapabilities({
    apiKey: process.env.NAVYAI_API_KEY,
    baseUrl: process.env.NAVYAI_API_URL,
  });
  return NextResponse.json({ ...capabilities, enabled: true });
}
