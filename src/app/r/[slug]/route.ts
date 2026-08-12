import { createHash, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { getTrackingSecrets } from "@/lib/tracking-secrets";
import { getRedirectTarget, recordTrackedClick, TrackingServiceError } from "@/lib/tracking-service";

export const runtime = "nodejs";
type Context = { params: Promise<{ slug: string }> };

const RESPONSE_HEADERS = {
  "cache-control": "no-store, max-age=0",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

function unavailable(status: 404 | 410) {
  return new NextResponse(status === 404 ? "Ссылка не найдена" : "Срок действия ссылки истёк", {
    status,
    headers: { ...RESPONSE_HEADERS, "content-type": "text/plain; charset=utf-8" },
  });
}

export async function GET(req: NextRequest, ctx: Context) {
  const requestId = randomUUID();
  try {
    const target = await getRedirectTarget(getPool(), (await ctx.params).slug);
    const ip = clientIp(req);
    const rateKey = createHash("sha256").update(`${target.linkId}\u0000${ip}`, "utf8").digest("hex").slice(0, 32);
    const rate = await checkRateLimit(`tracking:redirect:${rateKey}`, 300, 60);
    let token: string | null = null;
    if (rate.allowed) {
      try {
        const secrets = getTrackingSecrets();
        const click = await recordTrackedClick({
          pool: getPool(), target, ip,
          userAgent: req.headers.get("user-agent"),
          referrer: req.headers.get("referer"),
          ...secrets,
        });
        token = click.token;
      } catch (error) {
        console.error("[tracking-redirect] click was not recorded", {
          requestId,
          errorName: error instanceof Error ? error.name : "Error",
        });
      }
    }
    const destination = new URL(target.destinationUrl);
    if (token) destination.searchParams.set("aurora_attribution", token);
    const response = NextResponse.redirect(destination, 307);
    for (const [name, value] of Object.entries(RESPONSE_HEADERS)) response.headers.set(name, value);
    response.headers.set("x-request-id", requestId);
    return response;
  } catch (error) {
    if (error instanceof TrackingServiceError) {
      return unavailable(error.code === "link_unavailable" ? 410 : 404);
    }
    console.error("[tracking-redirect] destination lookup failed", {
      requestId,
      errorName: error instanceof Error ? error.name : "Error",
    });
    return new NextResponse("Ссылка временно недоступна", {
      status: 503,
      headers: { ...RESPONSE_HEADERS, "content-type": "text/plain; charset=utf-8", "retry-after": "30" },
    });
  }
}
