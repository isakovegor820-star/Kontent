import { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { requestMonthlyCampaignRegeneration } from "@/lib/monthly-campaign-service";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
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
  const rate = await checkRateLimit(`monthly-campaign:regenerate:user:${user.id}`, 30, 3_600, {
    failureMode: "closed",
  });
  if (!rate.allowed) return rateLimitResponse(rate);
  const params = await context.params;
  const campaignId = monthlyCampaignRouteId(params.campaignId);
  const planId = monthlyCampaignRouteId(params.planId);
  if (!campaignId || !planId) return monthlyCampaignJson({ ok: false, error: "bad_id" }, 400, requestId);
  const parsed = await readMonthlyCampaignBody(
    req, ["scope", "itemId", "weekStartsOn", "expectedPlanVersion", "idempotencyKey"],
  );
  if (!parsed.ok) return monthlyCampaignJson({ ok: false, error: parsed.error }, parsed.status, requestId);
  const body = parsed.body;
  try {
    const operation = await requestMonthlyCampaignRegeneration({
      pool: getPool(), actorUserId: user.id, campaignId, planId,
      scope: body.scope, itemId: body.itemId, weekStartsOn: body.weekStartsOn,
      expectedPlanVersion: body.expectedPlanVersion,
      idempotencyKey: body.idempotencyKey, requestId,
    });
    return monthlyCampaignJson({ ok: true, operation }, operation.duplicate ? 200 : 202, requestId);
  } catch (error) {
    return monthlyCampaignApiError(error, requestId);
  }
}
