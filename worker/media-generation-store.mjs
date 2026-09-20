import { randomUUID } from "node:crypto";
import { MediaGenerationAttemptError } from "./media-generation-worker.mjs";
import { releaseWorkerAiUsage } from "./ai-usage-reservation.mjs";
import { ownedTaskTransaction } from "./task-heartbeat.mjs";

export const MEDIA_GENERATION_FIELDS = `
  g.id, g.user_id, g.project_id, g.kind, g.status, g.prompt, g.negative_prompt, g.model,
  g.aspect_ratio, g.quality, g.seconds, g.style, g.provider_job_id,
  g.output_asset_id, g.ai_usage_reservation_id, g.request_id,
  g.request_key, g.provider_request_key, g.prompt_context, g.worker_lease_token`;

const identity = (generation) => ({ table: "media_generations", id: generation.id, token: generation.worker_lease_token });

export function createMediaGenerationStore(pool, persistResult) {
  return {
    async claim(job) {
      const result = await pool.query(
        `with eligible as (
           select g.id, g.status as previous_status,
                  u.status as usage_status, u.expires_at > now() as usage_live,
                  coalesce(g.worker_heartbeat_at, g.updated_at) < now() - interval '15 minutes' as generation_stale
             from media_generations g left join ai_usage u on u.id = g.ai_usage_reservation_id and u.user_id = g.user_id
            where g.id = $1 and g.request_key = $2 and g.request_id = $3::uuid
              and g.provider_request_key = $4 and g.project_id = $5
              and g.queue_confirmed_at is not null and g.output_asset_id is null
              and g.status in ('queued','submitting','generating','saving')
              and (g.status = 'queued' or coalesce(g.worker_heartbeat_at, g.updated_at) < now() - interval '2 minutes')
              and (g.worker_lease_token is null or coalesce(g.worker_heartbeat_at, g.updated_at) < now() - interval '2 minutes')
            for update of g
         )
         update media_generations g
            set status = 'submitting', worker_lease_token = $6, worker_heartbeat_at = now(),
                provider_started_at = coalesce(g.provider_started_at, now()), updated_at = now()
           from eligible e where g.id = e.id
         returning ${MEDIA_GENERATION_FIELDS}, e.previous_status, e.usage_status, e.usage_live, e.generation_stale`,
        [job.generationId, job.requestKey, job.requestId, job.providerRequestKey, job.projectId, randomUUID()],
      );
      const generation = result.rows[0];
      if (generation) {
        let error = null;
        if (generation.generation_stale) error = new MediaGenerationAttemptError("stale_generation", "Генерация прервалась и не завершилась вовремя. Можно запустить новую попытку.");
        else if (generation.previous_status !== "queued" && !generation.provider_job_id) {
          error = new MediaGenerationAttemptError("provider_outcome_unknown", "Не удалось подтвердить результат отправки провайдеру. Лимит не списан. Новую попытку можно запустить вручную.");
        } else if (generation.usage_status !== "reserved" || generation.usage_live !== true) {
          error = new MediaGenerationAttemptError("reservation_unavailable", "Резерв генерации истёк. Можно запустить новую попытку.");
        }
        return error ? { state: "rejected", generation, error } : { state: "claimed", generation };
      }
      const current = (await pool.query(
        `select ${MEDIA_GENERATION_FIELDS}, g.queue_confirmed_at from media_generations g where g.id = $1 and g.project_id = $2`,
        [job.generationId, job.projectId],
      )).rows[0];
      if (!current) return { state: "skip", reason: "not_found" };
      if (current.request_key !== job.requestKey || String(current.request_id) !== job.requestId || current.provider_request_key !== job.providerRequestKey) return { state: "skip", reason: "job_identity_mismatch" };
      if (["ready", "failed"].includes(current.status) || current.output_asset_id) return { state: "skip", reason: current.status };
      if (current.status === "queued" && !current.queue_confirmed_at) return { state: "handoff_pending", generation: current };
      return { state: "skip", reason: "worker_active" };
    },
    async markGenerating(generation, providerJobId) {
      await ownedTaskTransaction(pool, identity(generation), async (client) => {
        const result = await client.query(
          `update media_generations set status = 'generating', provider_job_id = $2, updated_at = now()
            where id = $1 and status = 'submitting' returning id`, [generation.id, providerJobId],
        );
        if (!result.rowCount) throw new MediaGenerationAttemptError("generation_not_eligible", "Генерация уже завершена или остановлена.");
      });
      generation.provider_job_id = providerJobId;
    },
    persistResult,
    async requeue(generation) {
      await ownedTaskTransaction(pool, identity(generation), (client) => client.query(
        `update media_generations set status = 'queued', worker_lease_token = null, worker_heartbeat_at = null,
                error_code = null, error_message = 'Провайдер временно занят — повторяем автоматически.', updated_at = now(), completed_at = null
          where id = $1 and status in ('submitting','generating','saving')`, [generation.id],
      ));
    },
    async failAndRelease(generation, error) {
      // An older worker cannot fail or release the reservation of its successor.
      await ownedTaskTransaction(pool, identity(generation), async (client) => {
        const failed = await client.query(
          `update media_generations set status = 'failed', worker_lease_token = null, worker_heartbeat_at = null,
                  error_code = $2, error_message = $3, updated_at = now(), completed_at = now()
            where id = $1 and status in ('queued','submitting','generating','saving') returning ai_usage_reservation_id, user_id`,
          [generation.id, error.code, String(error.message).slice(0, 300)],
        );
        if (failed.rows[0]?.ai_usage_reservation_id) await releaseWorkerAiUsage(client, failed.rows[0].user_id, failed.rows[0].ai_usage_reservation_id);
      });
    },
    async failByJobIdentity(job, error) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const failed = await client.query(
          `update media_generations set status = 'failed', error_code = $5, error_message = $6, updated_at = now(), completed_at = now()
            where id = $1 and request_key = $2 and request_id = $3::uuid and provider_request_key = $4
              and project_id = $7 and queue_confirmed_at is not null and status = 'queued' and worker_lease_token is null
            returning ai_usage_reservation_id, user_id`,
          [job.generationId, job.requestKey, job.requestId, job.providerRequestKey, error.code, String(error.message).slice(0, 300), job.projectId],
        );
        if (failed.rows[0]?.ai_usage_reservation_id) await releaseWorkerAiUsage(client, failed.rows[0].user_id, failed.rows[0].ai_usage_reservation_id);
        await client.query("commit");
      } catch (error) { await client.query("rollback").catch(() => undefined); throw error; }
      finally { client.release(); }
    },
  };
}

/** Repairs lost queue handoffs and stalled deliveries. Never calls a provider. */
export async function recoverMediaDeliveries(pool, queue) {
  const rows = await pool.query(
    `select id, project_id, request_id, request_key, provider_request_key from media_generations
      where status in ('queued','submitting','generating','saving') and queue_confirmed_at is not null
        and coalesce(worker_heartbeat_at, updated_at) < now() - interval '2 minutes'
      order by updated_at, id limit 50`,
  );
  let enqueued = 0;
  for (const row of rows.rows) {
    await queue.add("generate", {
      generationId: Number(row.id), projectId: Number(row.project_id), requestId: String(row.request_id),
      requestKey: row.request_key, providerRequestKey: row.provider_request_key,
    }, {
      jobId: `media-recovery-${row.id}-${Math.floor(Date.now() / 60_000)}`,
      attempts: 2, backoff: { type: "exponential", delay: 15_000 }, removeOnComplete: 100, removeOnFail: 100,
    });
    enqueued += 1;
  }
  return { enqueued };
}
