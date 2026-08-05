import type { Pool } from "pg";

type ReconciliationPool = Pick<Pool, "connect">;

export async function reconcileStaleMediaGeneration(
  pool: ReconciliationPool,
  input: { userId: number; generationId?: number; requestKey?: string; staleAfterMinutes?: number },
) {
  const generationId = input.generationId ?? null;
  const requestKey = input.requestKey ?? null;
  if (generationId == null && requestKey == null) {
    throw new TypeError("media reconciliation requires generation identity");
  }
  const staleAfterMinutes = Math.max(15, Math.min(24 * 60, Math.trunc(input.staleAfterMinutes ?? 15)));
  const client = await pool.connect();
  try {
    await client.query("begin");
    const failed = await client.query<{ id: string; ai_usage_reservation_id: string | null }>(
      `update media_generations
          set status = 'failed', error_code = 'stale_generation',
              error_message = 'Генерация не получила terminal-событие вовремя. Запусти её ещё раз.',
              updated_at = now(), completed_at = now()
        where user_id = $1
          and ($2::bigint is null or id = $2)
          and ($3::text is null or request_key = $3)
          and status in ('queued','submitting','generating','saving')
          and updated_at < now() - ($4::int * interval '1 minute')
      returning id, ai_usage_reservation_id`,
      [input.userId, generationId, requestKey, staleAfterMinutes],
    );
    const reservationIds = failed.rows
      .map((row) => Number(row.ai_usage_reservation_id))
      .filter((id) => Number.isSafeInteger(id) && id > 0);
    if (reservationIds.length) {
      await client.query(
        `update ai_usage
            set status = 'released', finalized_at = now()
          where user_id = $1 and id = any($2::bigint[]) and status = 'reserved'`,
        [input.userId, reservationIds],
      );
    }
    await client.query("commit");
    return { reconciled: failed.rows.map((row) => Number(row.id)), released: reservationIds };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
