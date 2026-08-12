import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { markTrackerPing, verifyTrackerCorsOrigin } from "@/lib/tracking-service";
import {
  readTrackingBodyResult,
  trackingBodyFailure,
  trackerCorsHeaders,
  trackingApiError,
  trackingJson,
  trackingRateKey,
} from "../_shared";

export const runtime = "nodejs";

function projectKey(req: NextRequest) {
  return req.headers.get("x-aurora-project-key");
}

function withCors(response: NextResponse, origin: string) {
  for (const [name, value] of Object.entries(trackerCorsHeaders(origin))) response.headers.set(name, value);
  return response;
}

export async function OPTIONS(req: NextRequest) {
  try {
    const origin = await verifyTrackerCorsOrigin(getPool(), {
      publicKey: projectKey(req), requestOrigin: req.headers.get("origin"), requireActive: false,
    });
    return new NextResponse(null, { status: 204, headers: trackerCorsHeaders(origin) });
  } catch {
    return new NextResponse(null, { status: 403, headers: { "cache-control": "no-store", vary: "Origin" } });
  }
}

export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  const ip = clientIp(req);
  const ingressRate = await checkRateLimit(
    trackingRateKey("ping:ip", ip),
    120,
    600,
    { failureMode: "closed" },
  );
  if (!ingressRate.allowed) return rateLimitResponse(ingressRate);
  const parsed = await readTrackingBodyResult(req, ["publicKey"]);
  if (!parsed.ok) return trackingBodyFailure(parsed, requestId);
  const body = parsed.body;
  let origin: string;
  try {
    origin = await verifyTrackerCorsOrigin(getPool(), {
      publicKey: body.publicKey, requestOrigin: req.headers.get("origin"), requireActive: false,
    });
  } catch (error) {
    return trackingApiError(error, requestId);
  }
  const rate = await checkRateLimit(
    trackingRateKey("ping:project-ip", body.publicKey, ip),
    30,
    600,
    { failureMode: "closed" },
  );
  if (!rate.allowed) return withCors(rateLimitResponse(rate), origin);
  try {
    const tracking = await markTrackerPing(getPool(), {
      publicKey: body.publicKey, requestOrigin: origin,
    });
    return withCors(trackingJson({
      ok: true,
      status: "signal_received",
      verificationStatus: tracking.status,
    }, 200, requestId), origin);
  } catch (error) {
    return withCors(trackingApiError(error, requestId), origin);
  }
}
