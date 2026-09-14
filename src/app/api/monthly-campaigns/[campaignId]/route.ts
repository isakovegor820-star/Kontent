import { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { getMonthlyCampaign, updateMonthlyCampaign } from "@/lib/monthly-campaign-service";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import {
  monthlyCampaignApiError,
  monthlyCampaignJson,
  monthlyCampaignRequestId,
  monthlyCampaignRouteId,
  readMonthlyCampaignBody,
} from "../_shared";

export const runtime = "nodejs";
type Context = { params: Promise<{ campaignId: string }> };

async function campaignId(context: Context): Promise<number | null> {
  return monthlyCampaignRouteId((await context.params).campaignId);
}

export async function GET(request: NextRequest, context: Context) {
  const requestId = monthlyCampaignRequestId();
  const user = await getSessionUser(request);
  if (!user) return monthlyCampaignJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const id = await campaignId(context);
  if (!id) return monthlyCampaignJson({ ok: false, error: "bad_id" }, 400, requestId);
  try {
    const result = await getMonthlyCampaign({ pool: getPool(), actorUserId: user.id, campaignId: id });
    return monthlyCampaignJson({ ok: true, ...result }, 200, requestId);
  } catch (error) {
    return monthlyCampaignApiError(error, requestId);
  }
}

export async function PATCH(req: NextRequest, context: Context) {
  if (!hasTrustedMutationOrigin(req)) {
    return monthlyCampaignJson({ ok: false, error: "forbidden_origin" }, 403);
  }
  const requestId = monthlyCampaignRequestId();
  const user = await getSessionUser(req);
  if (!user) return monthlyCampaignJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const id = await campaignId(context);
  if (!id) return monthlyCampaignJson({ ok: false, error: "bad_id" }, 400, requestId);
  const parsed = await readMonthlyCampaignBody(req, ["brief", "expectedVersion"]);
  if (!parsed.ok) return monthlyCampaignJson({ ok: false, error: parsed.error }, parsed.status, requestId);
  const body = parsed.body;
  try {
    const campaign = await updateMonthlyCampaign({
      pool: getPool(), actorUserId: user.id, campaignId: id,
      brief: body.brief, expectedVersion: body.expectedVersion, requestId,
    });
    return monthlyCampaignJson({ ok: true, campaign }, 200, requestId);
  } catch (error) {
    return monthlyCampaignApiError(error, requestId);
  }
}
