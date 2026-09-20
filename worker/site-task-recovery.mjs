import { enqueuePendingInterpretations, enqueuePendingRefinements } from "./site-ai-worker.mjs";

export async function recoverSiteTasks(pool, queue) {
  const profiles = await enqueuePendingRefinements(pool, queue);
  const interpretations = await enqueuePendingInterpretations(pool, queue);
  const articles = await pool.query(
    `select a.id, a.version from site_articles a join sites s on s.id = a.site_id
      where s.status = 'active' and a.status in ('draft','generating')
        and coalesce(a.worker_heartbeat_at, a.updated_at) < now() - interval '2 minutes'
      order by a.updated_at, a.id limit 50`,
  );
  for (const row of articles.rows) await queue.add("generate", { articleId: Number(row.id), version: Number(row.version) }, {
    jobId: `site-articles-generate-${row.id}-v${row.version}-recovery-${Math.floor(Date.now() / 60_000)}`,
    attempts: 2, backoff: { type: "exponential", delay: 30_000 }, removeOnComplete: 100, removeOnFail: 100,
  });
  return { profiles, interpretations, articles: articles.rows.length };
}
