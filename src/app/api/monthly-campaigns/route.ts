import { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { createMonthlyCampaign, listMonthlyCampaigns } from "@/lib/monthly-campaign-service";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import {
  monthlyCampaignApiError,
  monthlyCampaignJson,
  monthlyCampaignRequestId,
  readMonthlyCampaignBody,
} from "./_shared";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const requestId = monthlyCampaignRequestId();
  const user = await getSessionUser(request);
  if (!user) return monthlyCampaignJson({ ok: false, error: "unauthorized" }, 401, requestId);
  try {
    const campaigns = await listMonthlyCampaigns({ pool: getPool(), actorUserId: user.id });
    return monthlyCampaignJson({ ok: true, campaigns }, 200, requestId);
  } catch (error) {
    return monthlyCampaignApiError(error, requestId);
  }
}

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return monthlyCampaignJson({ ok: false, error: "forbidden_origin" }, 403);
  }
  const requestId = monthlyCampaignRequestId();
  const user = await getSessionUser(req);
  if (!user) return monthlyCampaignJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const parsed = await readMonthlyCampaignBody(req, ["brief", "idempotencyKey"]);
  if (!parsed.ok) return monthlyCampaignJson({ ok: false, error: parsed.error }, parsed.status, requestId);
  const body = parsed.body;
  try {
    const result = await createMonthlyCampaign({
      pool: getPool(),
      actorUserId: user.id,
      brief: body.brief,
      idempotencyKey: body.idempotencyKey,
      requestId,
    });
    return monthlyCampaignJson({ ok: true, ...result }, result.duplicate ? 200 : 201, requestId);
  } catch (error) {
    return monthlyCampaignApiError(error, requestId);
  }
}
