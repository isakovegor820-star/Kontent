import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { requireAiWorkAccess, AiWorkAccessError } from "./ai-work-access.mjs";

const scopeStorage = new AsyncLocalStorage();
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
export class AiSpendError extends Error {
  constructor(code, dimension = null) {
    super(code);
    this.name = "AiSpendError";
    this.code = code;
    this.dimension = dimension;
  }
}
function integer(value, min = 1) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min ? n : null;
}

/** Attribution is explicit, inherited only by asynchronous work created inside this scope. */
export function withAiSpendScope(scope, task) {
  if (!integer(scope?.userId) || !integer(scope?.projectId) || typeof scope?.pool?.connect !== "function") {
    throw new AiSpendError("ai_spend_scope_required");
  }
  return scopeStorage.run({ pool: scope.pool, userId: Number(scope.userId), projectId: Number(scope.projectId), permission: scope.permission || "content.create" }, task);
}

export function resolveAiSpendPolicy(provider, model, env = process.env) {
  const names = ["USER_DAILY_MICROUSD", "PROJECT_DAILY_MICROUSD", "GLOBAL_DAILY_MICROUSD", "USER_CONCURRENCY", "PROJECT_CONCURRENCY", "GLOBAL_CONCURRENCY"];
  const values = names.map(name => integer(env[`AI_SPEND_${name}`]));
  if (values.some(value => value === null)) throw new AiSpendError("ai_spend_configuration_required");
  let tariffs;
  try { tariffs = JSON.parse(env.AI_SPEND_TARIFFS_JSON || ""); } catch { throw new AiSpendError("ai_spend_configuration_required", "tariff"); }
  const raw = tariffs?.[`${provider}/${model}`];
  const inputRate = integer(raw?.inputMicrousdPerMillionTokens, 0);
  const outputRate = integer(raw?.outputMicrousdPerMillionTokens, 0);
  const unitRate = integer(raw?.unitMicrousd ?? 0, 0);
  if (inputRate === null || outputRate === null || unitRate === null || inputRate + outputRate + unitRate <= 0) {
    throw new AiSpendError("ai_spend_configuration_required", "tariff");
  }
  return {
    userCap: values[0], projectCap: values[1], globalCap: values[2],
    userConcurrency: values[3], projectConcurrency: values[4], globalConcurrency: values[5],
    tariff: { inputMicrousdPerMillionTokens: inputRate, outputMicrousdPerMillionTokens: outputRate, unitMicrousd: unitRate },
  };
}

export function aiSpendCost(tariff, inputTokens, outputTokens, units = 0) {
  if ([inputTokens, outputTokens, units].some(value => integer(value, 0) === null)) {
    throw new AiSpendError("ai_spend_invalid_projection");
  }
  const amount = (BigInt(inputTokens) * BigInt(tariff.inputMicrousdPerMillionTokens)
    + BigInt(outputTokens) * BigInt(tariff.outputMicrousdPerMillionTokens) + 999_999n) / 1_000_000n
    + BigInt(units) * BigInt(tariff.unitMicrousd);
  if (amount > BigInt(MAX_SAFE)) throw new AiSpendError("ai_spend_invalid_projection");
  return Number(amount);
}

/**
 * Reserve a pessimistic bound BEFORE every paid attempt, including fallback/classification.
 * Refunds in ai_usage never affect this ledger. A crashed/unknown attempt retains its bound;
 * lease expiry releases only concurrency. All budget checks share one short DB lock so
 * separate web/worker processes cannot race global limits.
 */
export async function beginAiSpendAttempt(input, options = {}) {
  const scope = options.scope || scopeStorage.getStore();
  if (input.provider === "local") {
    // An explicitly attributed local request handles the same private project data
    // as a paid one. Free public-corpus work may remain unattributed.
    if (scope) await requireAiWorkAccess(scope.pool, scope);
    return { id: null, finish: async () => {} };
  }
  if (!scope || !integer(scope.userId) || !integer(scope.projectId) || !scope.pool?.connect) {
    throw new AiSpendError("ai_spend_scope_required");
  }
  const policy = resolveAiSpendPolicy(input.provider, input.model, options.env || process.env);
  const reserved = aiSpendCost(policy.tariff, input.inputTokens, input.outputTokens, input.units || 0);
  if (reserved <= 0) throw new AiSpendError("ai_spend_invalid_projection");
  const id = randomUUID();
  const tx = await scope.pool.connect();
  try {
    await tx.query("begin");
    await tx.query("select pg_advisory_xact_lock(749012603::bigint)");
    try { await requireAiWorkAccess(tx, scope); }
    catch (error) {
      if (error instanceof AiWorkAccessError) throw new AiSpendError("ai_spend_scope_forbidden");
      throw error;
    }
    const row = (await tx.query(`select
      coalesce(sum(coalesce(charged_microusd,reserved_microusd)) filter (where budget_date = (now() at time zone 'UTC')::date),0)::text as global_spend,
      coalesce(sum(coalesce(charged_microusd,reserved_microusd)) filter (where budget_date = (now() at time zone 'UTC')::date and user_id=$1),0)::text as user_spend,
      coalesce(sum(coalesce(charged_microusd,reserved_microusd)) filter (where budget_date = (now() at time zone 'UTC')::date and project_id=$2),0)::text as project_spend,
      count(*) filter (where status='reserved' and lease_expires_at>now())::int as global_active,
      count(*) filter (where status='reserved' and lease_expires_at>now() and user_id=$1)::int as user_active,
      count(*) filter (where status='reserved' and lease_expires_at>now() and project_id=$2)::int as project_active
      from ai_spend_attempts
      where budget_date = (now() at time zone 'UTC')::date or (status='reserved' and lease_expires_at>now())`, [scope.userId, scope.projectId])).rows[0];
    for (const dimension of ["user", "project", "global"]) {
      if (BigInt(row[`${dimension}_spend`]) + BigInt(reserved) > BigInt(policy[`${dimension}Cap`])) {
        throw new AiSpendError("ai_spend_cap_exceeded", dimension);
      }
      if (Number(row[`${dimension}_active`]) >= policy[`${dimension}Concurrency`]) {
        throw new AiSpendError("ai_spend_concurrency_exceeded", dimension);
      }
    }
    await tx.query(`insert into ai_spend_attempts
      (id,user_id,project_id,provider,model,reserved_microusd,tariff,input_token_bound,output_token_bound,unit_bound)
      values ($1::uuid,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,
    [id,scope.userId,scope.projectId,String(input.provider).slice(0,80),String(input.model).slice(0,160),reserved,JSON.stringify(policy.tariff),input.inputTokens,input.outputTokens,input.units || 0]);
    await tx.query("commit");
  } catch (error) {
    await tx.query("rollback").catch(() => {});
    throw error;
  } finally { tx.release(); }
  return {
    id,
    async finish({ outcome, usage } = {}) {
      const known = usage && integer(usage.inputTokens, 0) !== null && integer(usage.outputTokens, 0) !== null;
      // Provider-reported usage can exceed a bad projection. Preserve the real number and
      // trip subsequent caps; never erase the cost to make the prior bound look correct.
      const cost = known ? aiSpendCost(policy.tariff, usage.inputTokens, usage.outputTokens, input.units || 0) : reserved;
      const status = outcome === "succeeded" ? "succeeded" : outcome === "failed" ? "failed" : "unknown";
      await scope.pool.query(`update ai_spend_attempts set status=$2,charged_microusd=$3,usage_known=$4,
        input_tokens=$5,output_tokens=$6,finalized_at=now()
        where id=$1::uuid and status='reserved'`, [id,status,cost,Boolean(known),known ? usage.inputTokens : null,known ? usage.outputTokens : null]);
    },
  };
}

export async function withChannelAiSpendScope(pool, userId, channelId, task) {
  const row = (await pool.query(`select project_id from channels where id=$1 and is_active=true`, [channelId])).rows[0];
  if (!row) throw new AiSpendError("ai_spend_scope_required");
  return withAiSpendScope({ pool, userId: Number(userId), projectId: Number(row.project_id) }, task);
}

/** Unowned public-corpus maintenance uses an explicitly configured accounting project. */
export function withSystemAiSpendScope(pool, task, env = process.env) {
  const userId = integer(env.AI_SPEND_SYSTEM_USER_ID);
  const projectId = integer(env.AI_SPEND_SYSTEM_PROJECT_ID);
  // Local embeddings can still work without a monetary account. Cloud boundaries below
  // always refuse missing attribution; this never enables an unaccounted paid call.
  if (!userId || !projectId) return task();
  return withAiSpendScope({ pool, userId, projectId }, task);
}
