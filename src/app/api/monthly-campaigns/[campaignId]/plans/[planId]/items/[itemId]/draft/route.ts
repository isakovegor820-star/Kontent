import { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { ensureMonthlyCampaignItemDraft } from "@/lib/monthly-campaign-service";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import {
  monthlyCampaignApiError,
  monthlyCampaignJson,
  monthlyCampaignRequestId,
  monthlyCampaignRouteId,
  readMonthlyCampaignBody,
} from "../../../../../../_shared";

export const runtime = "nodejs";
type Context = { params: Promise<{ campaignId: string; planId: string; itemId: string }> };

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
  const itemId = monthlyCampaignRouteId(params.itemId);
  if (!campaignId || !planId || !itemId) {
    return monthlyCampaignJson({ ok: false, error: "bad_id" }, 400, requestId);
  }
  const parsed = await readMonthlyCampaignBody(req, ["channelId", "draftId"]);
  if (!parsed.ok) return monthlyCampaignJson({ ok: false, error: parsed.error }, parsed.status, requestId);
  try {
    const result = await ensureMonthlyCampaignItemDraft({
      pool: getPool(),
      actorUserId: user.id,
      campaignId,
      planId,
      itemId,
      channelId: parsed.body.channelId,
      attachDraftId: parsed.body.draftId,
    });
    return monthlyCampaignJson({
      ok: true,
      draftId: result.draftId,
      created: result.created,
      item: result.item,
    }, result.created ? 201 : 200, requestId);
  } catch (error) {
    return monthlyCampaignApiError(error, requestId);
  }
}
