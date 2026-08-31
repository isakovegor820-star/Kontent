import { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import {
  refreshMonthlyCampaignPlanProfile,
  transitionMonthlyCampaignPlan,
} from "@/lib/monthly-campaign-service";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import {
  monthlyCampaignApiError,
  monthlyCampaignJson,
  monthlyCampaignRequestId,
  monthlyCampaignRouteId,
  readMonthlyCampaignBody,
} from "../../../_shared";

export const runtime = "nodejs";
type Context = { params: Promise<{ campaignId: string; planId: string }> };

export async function PATCH(req: NextRequest, context: Context) {
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
  const parsed = await readMonthlyCampaignBody(req, ["action", "expectedPlanVersion"]);
  if (!parsed.ok) return monthlyCampaignJson({ ok: false, error: parsed.error }, parsed.status, requestId);
  const body = parsed.body;
  try {
    const plan = body.action === "refresh"
      ? await refreshMonthlyCampaignPlanProfile({
        pool: getPool(), actorUserId: user.id, campaignId, planId,
        expectedPlanVersion: body.expectedPlanVersion, requestId,
      })
      : await transitionMonthlyCampaignPlan({
        pool: getPool(), actorUserId: user.id, campaignId, planId,
        action: body.action, expectedPlanVersion: body.expectedPlanVersion, requestId,
      });
    return monthlyCampaignJson({ ok: true, plan }, 200, requestId);
  } catch (error) {
    return monthlyCampaignApiError(error, requestId);
  }
}
