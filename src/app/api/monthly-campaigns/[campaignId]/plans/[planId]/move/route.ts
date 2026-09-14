import { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { moveMonthlyCampaignItem } from "@/lib/monthly-campaign-service";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import {
  monthlyCampaignApiError,
  monthlyCampaignJson,
  monthlyCampaignRequestId,
  monthlyCampaignRouteId,
  readMonthlyCampaignBody,
} from "../../../../_shared";

export const runtime = "nodejs";
type Context = { params: Promise<{ campaignId: string; planId: string }> };

export async function POST(req: NextRequest, context: Context) {
  if (!hasTrustedMutationOrigin(req)) {
    return monthlyCampaignJson({ ok: false, error: "forbidden_origin" }, 403);
  }
  const requestId = monthlyCampaignRequestId();
  const user = await getSessionUser(req);
  if (!user) return monthlyCampaignJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const params = await context.params;
  const campaignId = monthlyCampaignRouteId(params.campaignId);
  const planId = monthlyCampaignRouteId(params.planId);
  if (!campaignId || !planId) return monthlyCampaignJson({ ok: false, error: "bad_id" }, 400, requestId);
  const parsed = await readMonthlyCampaignBody(
    req, ["itemId", "targetDate", "targetPosition", "expectedPlanVersion"],
  );
  if (!parsed.ok) return monthlyCampaignJson({ ok: false, error: parsed.error }, parsed.status, requestId);
  const body = parsed.body;
  if (typeof body.itemId !== "number") {
    return monthlyCampaignJson({ ok: false, error: "bad_request" }, 400, requestId);
  }
  try {
    const result = await moveMonthlyCampaignItem({
      pool: getPool(), actorUserId: user.id, campaignId, planId,
      itemId: body.itemId, targetDate: body.targetDate,
      targetPosition: body.targetPosition, expectedPlanVersion: body.expectedPlanVersion, requestId,
    });
    return monthlyCampaignJson({ ok: true, ...result }, 200, requestId);
  } catch (error) {
    return monthlyCampaignApiError(error, requestId);
  }
}
