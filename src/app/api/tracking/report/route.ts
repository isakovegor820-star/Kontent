import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getProjectTrackingReport } from "@/lib/tracking-service";
import { trackingApiError, trackingJson } from "../_shared";

export const runtime = "nodejs";

function dateParam(value: string | null) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(Number.NaN) : date;
}

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return trackingJson({ ok: false, error: "unauthorized" }, 401, requestId);
  try {
    const report = await getProjectTrackingReport(getPool(), {
      actorUserId: user.id,
      from: dateParam(req.nextUrl.searchParams.get("from")),
      to: dateParam(req.nextUrl.searchParams.get("to")),
    });
    return trackingJson({ ok: true, report }, 200, requestId);
  } catch (error) {
    return trackingApiError(error, requestId);
  }
}
