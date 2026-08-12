import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { getTrackingSecrets } from "@/lib/tracking-secrets";
import { recordConversionEvent, verifyTrackerCorsOrigin } from "@/lib/tracking-service";
import {
  readTrackingBodyResult,
  trackingBodyFailure,
  trackerCorsHeaders,
  trackingApiError,
  trackingJson,
  trackingRateKey,
} from "../_shared";

export const runtime = "nodejs";

function withCors(response: NextResponse, origin: string) {
  for (const [name, value] of Object.entries(trackerCorsHeaders(origin))) response.headers.set(name, value);
  return response;
}

export async function OPTIONS(req: NextRequest) {
  try {
    const origin = await verifyTrackerCorsOrigin(getPool(), {
      publicKey: req.headers.get("x-aurora-project-key"),
      requestOrigin: req.headers.get("origin"),
      requireActive: true,
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
    trackingRateKey("conversion:ip", ip),
    180,
    600,
    { failureMode: "closed" },
  );
  if (!ingressRate.allowed) return rateLimitResponse(ingressRate);
  const parsed = await readTrackingBodyResult(req, [
    "publicKey",
    "token",
    "idempotencyKey",
    "eventType",
    "occurredAt",
  ]);
  if (!parsed.ok) return trackingBodyFailure(parsed, requestId);
  const body = parsed.body;
  let origin: string;
  try {
    origin = await verifyTrackerCorsOrigin(getPool(), {
      publicKey: body.publicKey, requestOrigin: req.headers.get("origin"), requireActive: true,
    });
  } catch (error) {
    return trackingApiError(error, requestId);
  }
  const rate = await checkRateLimit(
    trackingRateKey("conversion:project-ip", body.publicKey, ip),
    60,
    600,
    { failureMode: "closed" },
  );
  if (!rate.allowed) return withCors(rateLimitResponse(rate), origin);
  try {
    const { attributionSecret } = getTrackingSecrets();
    const conversion = await recordConversionEvent({
      pool: getPool(), publicKey: body.publicKey, token: body.token,
      idempotencyKey: req.headers.get("idempotency-key") ?? body.idempotencyKey,
      eventType: body.eventType, occurredAt: body.occurredAt,
      requestOrigin: origin, attributionSecret,
    });
    return withCors(trackingJson({ ok: true, conversion }, conversion.duplicate ? 200 : 201, requestId), origin);
  } catch (error) {
    return withCors(trackingApiError(error, requestId), origin);
  }
}
