export const DEFAULT_OVERDUE_GRACE_MS = 5 * 60_000;
export const DEFAULT_QUARANTINE_BATCH_SIZE = 250;
export const DEFAULT_QUARANTINE_MAX_BATCHES = 40;

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
}

export function publicationGraceMs(env = process.env) {
  return boundedInteger(
    env.PUBLICATION_OVERDUE_GRACE_MS,
    DEFAULT_OVERDUE_GRACE_MS,
    60_000,
    60 * 60_000,
  );
}

export function duePublicationRevision(jobData) {
  const value = Number(jobData?.scheduleRevision ?? 1);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function ageBucket(scheduledAt, nowMs) {
  const ageMs = Math.max(0, nowMs - new Date(scheduledAt).getTime());
  if (ageMs < 60 * 60_000) return "under_1h";
  if (ageMs < 24 * 60 * 60_000) return "1h_24h";
  if (ageMs < 7 * 24 * 60 * 60_000) return "1d_7d";
  return "over_7d";
}

function summarizeRows(rows, nowMs) {
  const groups = new Map();
  for (const row of rows) {
    const summary = {
      origin: String(row.publication_origin || "legacy"),
      channelId: Number(row.channel_id),
      age: ageBucket(row.scheduled_at, nowMs),
      count: 0,
    };
    const key = `${summary.origin}:${summary.channelId}:${summary.age}`;
    const current = groups.get(key) || summary;
    current.count += 1;
    groups.set(key, current);
  }
  return [...groups.values()].sort(
    (left, right) => left.channelId - right.channelId
      || left.origin.localeCompare(right.origin)
      || left.age.localeCompare(right.age),
  );
}

/**
 * Quarantine missed schedules before any queue consumer starts. Every batch is locked and
 * updated atomically; if the safety cap is exceeded bootstrap fails instead of publishing
 * the unreviewed remainder.
 */
export async function quarantineOverduePublications(pool, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const graceMs = boundedInteger(
    options.graceMs,
    DEFAULT_OVERDUE_GRACE_MS,
    60_000,
    60 * 60_000,
  );
  const batchSize = boundedInteger(
    options.batchSize,
    DEFAULT_QUARANTINE_BATCH_SIZE,
    1,
    1_000,
  );
  const maxBatches = boundedInteger(
    options.maxBatches,
    DEFAULT_QUARANTINE_MAX_BATCHES,
    1,
    100,
  );
  const cutoff = new Date(nowMs - graceMs);
  const summaries = [];
  let quarantined = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const client = await pool.connect();
    let rows = [];
    try {
      await client.query("begin");
      rows = (
        await client.query(
          `select p.id, p.channel_id, p.publication_origin, p.scheduled_at
             from posts p
            where p.status = 'scheduled'
              and p.scheduled_at is not null
              and p.scheduled_at < $1
            order by p.scheduled_at, p.id
            limit $2
            for update of p skip locked`,
          [cutoff, batchSize],
        )
      ).rows ?? [];
      if (rows.length === 0) {
        await client.query("commit");
        break;
      }
      const summary = summarizeRows(rows, nowMs);
      summaries.push(...summary);
      options.onDryRun?.({ cutoff: cutoff.toISOString(), total: rows.length, groups: summary });
      const ids = rows.map((row) => Number(row.id));
      const updated = await client.query(
        `update posts
            set status = 'quarantined', quarantined_at = $2,
                quarantine_reason = 'overdue_requires_new_schedule',
                next_attempt_at = null,
                last_error = 'Дата публикации истекла — выберите новую дату'
          where id = any($1::bigint[]) and status = 'scheduled'
          returning id`,
        [ids, new Date(nowMs)],
      );
      quarantined += updated.rowCount ?? 0;
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    if (rows.length < batchSize) break;
  }

  const remaining = Number((
    await pool.query(
      `select count(*)::int as count
         from posts
        where status = 'scheduled' and scheduled_at is not null and scheduled_at < $1`,
      [cutoff],
    )
  ).rows?.[0]?.count ?? 0);
  if (remaining > 0) {
    const error = new Error("overdue quarantine safety cap exceeded");
    error.code = "OVERDUE_QUARANTINE_LIMIT";
    error.remaining = remaining;
    throw error;
  }
  return { quarantined, remaining, cutoff: cutoff.toISOString(), groups: summaries };
}

