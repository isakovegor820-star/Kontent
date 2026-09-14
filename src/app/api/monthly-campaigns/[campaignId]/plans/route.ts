import { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { createMonthlyCampaignPlan, getMonthlyCampaign } from "@/lib/monthly-campaign-service";
import { buildMonthlyCampaignSeedItems } from "@/lib/monthly-campaign-seed";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import {
  monthlyCampaignApiError,
  monthlyCampaignJson,
  monthlyCampaignRequestId,
  monthlyCampaignRouteId,
  readMonthlyCampaignBody,
} from "../../_shared";

export const runtime = "nodejs";
type Context = { params: Promise<{ campaignId: string }> };

export async function POST(req: NextRequest, context: Context) {
  if (!hasTrustedMutationOrigin(req)) {
    return monthlyCampaignJson({ ok: false, error: "forbidden_origin" }, 403);
  }
  const requestId = monthlyCampaignRequestId();
  const user = await getSessionUser(req);
  if (!user) return monthlyCampaignJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const campaignId = monthlyCampaignRouteId((await context.params).campaignId);
  if (!campaignId) return monthlyCampaignJson({ ok: false, error: "bad_id" }, 400, requestId);
  const parsed = await readMonthlyCampaignBody(
    req,
    ["items", "generationMode", "expectedCampaignVersion", "idempotencyKey"],
  );
  if (!parsed.ok) return monthlyCampaignJson({ ok: false, error: parsed.error }, parsed.status, requestId);
  const body = parsed.body;
  if (body.generationMode != null && body.generationMode !== "editorial_seed") {
    return monthlyCampaignJson({ ok: false, error: "bad_request" }, 400, requestId);
  }
  try {
    const items = body.generationMode === "editorial_seed"
      ? buildMonthlyCampaignSeedItems((await getMonthlyCampaign({
        pool: getPool(), actorUserId: user.id, campaignId,
      })).campaign)
      : body.items;
    const result = await createMonthlyCampaignPlan({
      pool: getPool(), actorUserId: user.id, campaignId,
      expectedCampaignVersion: body.expectedCampaignVersion,
      items, idempotencyKey: body.idempotencyKey, requestId,
    });
    return monthlyCampaignJson({ ok: true, ...result }, result.duplicate ? 200 : 201, requestId);
  } catch (error) {
    return monthlyCampaignApiError(error, requestId);
  }
}
