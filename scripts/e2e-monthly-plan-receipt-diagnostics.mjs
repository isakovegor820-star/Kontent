import { createHash } from "node:crypto";
const hash = value => typeof value === "string" ? createHash("sha256").update(value).digest("hex") : null;
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;

// Bounded read-only diagnosis. This never grants a mutation cancellation or retry.
export async function readMonthlyPlanReceiptDiagnostics(pool, diagnostics) {
  const facts = [];
  for (const row of diagnostics.filter(row => row.method === "POST"
    && /^\/api\/monthly-campaigns\/[1-9]\d*\/plans$/u.test(row.path)).slice(0, 64)) {
    const ack = row.monthlyPlanAck;
    const campaignId = positive(row.path.split("/")[3]);
    const projectId = positive(ack?.projectId);
    const fact = { requestId: row.id, campaignId, projectId, ledger: null }; facts.push(fact);
    if (!pool || !projectId || !campaignId) { fact.unavailable = "incomplete_request_identity"; continue; }
    const result = await pool.query({ text: `select entity_id, project_id, actor_user_id, after_version, safe_data, request_id, idempotency_key
      from audit_events where action = 'monthly_campaign.plan_created' and entity_type = 'monthly_campaign_plan'
        and project_id = $1 and safe_data->>'campaign_id' = $2::text order by id desc limit 2`,
      values: [projectId, campaignId], query_timeout: 5_000 });
    fact.rowCount = result.rows.length;
    const prefix = `monthly-campaign:plan:${campaignId}:`;
    const matching = result.rows.filter(value => value.idempotency_key?.startsWith(prefix)
      && hash(value.idempotency_key.slice(prefix.length)) === ack.request?.idempotencyKeyHash
      && hash(value.request_id) === ack.responseRequestIdHash);
    fact.matchCount = matching.length;
    if (matching.length !== 1) continue;
    const value = matching[0];
    fact.ledger = { planId: positive(value.entity_id), projectId: positive(value.project_id), actorUserId: positive(value.actor_user_id),
      version: positive(value.after_version), campaignId: positive(value.safe_data?.campaign_id),
      revision: positive(value.safe_data?.revision), itemCount: positive(value.safe_data?.item_count),
      requestIdHash: hash(value.request_id), idempotencyKeyHash: hash(value.idempotency_key.slice(prefix.length)) };
    fact.responseMatchesLedger = Boolean(ack.native?.bodyComplete && ack.native?.responseCorrelation
      && ack.native?.statusMatches && ack.native?.bodyOk && ack.native?.jsonValid
      && ["planId", "projectId", "version", "campaignId", "revision", "itemCount"].every(key => fact.ledger[key] !== null && fact.ledger[key] === ack.receipt?.[key]));
  }
  return facts;
}
