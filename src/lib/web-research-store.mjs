// Хранилище фактов, добытых Авророй в интернете.
//
// Модуль общий для веб-процесса и воркера, поэтому это `.mjs` без импортов типов:
// воркер запускается обычным node и TypeScript-модули ему недоступны. Соединение с
// базой всегда передаётся аргументом `db` — модуль не создаёт пул сам.

export class WebResearchStoreError extends Error {
  constructor(code) {
    super(code);
    this.name = "WebResearchStoreError";
    this.code = code;
  }
}

function positiveId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function requireScope(scope) {
  const projectId = positiveId(scope?.projectId);
  const channelId = positiveId(scope?.channelId);
  if (!projectId || !channelId) throw new WebResearchStoreError("bad_scope");
  return { projectId, channelId };
}

export async function startWebResearchRun(db, scope, input) {
  const { projectId, channelId } = requireScope(scope);
  const row = (await db.query(
    `insert into web_research_runs
       (project_id, channel_id, trigger_kind, topic, categories, language, plan_fingerprint, queries)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     returning id`,
    [
      projectId,
      channelId,
      input?.triggerKind || "manual",
      String(input?.topic || "").slice(0, 500),
      Array.isArray(input?.categories) ? input.categories.slice(0, 8) : [],
      ["RU", "EN", "ANY"].includes(input?.language) ? input.language : "RU",
      String(input?.planFingerprint || "").slice(0, 80) || "unknown",
      JSON.stringify(Array.isArray(input?.queries) ? input.queries : []),
    ],
  )).rows[0];
  const id = positiveId(row?.id);
  if (!id) throw new WebResearchStoreError("bad_run");
  return id;
}

export async function finishWebResearchRun(db, runId, input) {
  const id = positiveId(runId);
  if (!id) throw new WebResearchStoreError("bad_run");
  await db.query(
    `update web_research_runs
        set status = $2, log = $3::jsonb, stats = $4::jsonb,
            findings_count = $5, rejections_count = $6, error = $7, finished_at = now()
      where id = $1`,
    [
      id,
      input?.status === "failed" ? "failed" : "completed",
      JSON.stringify(Array.isArray(input?.log) ? input.log.slice(-200) : []),
      JSON.stringify(input?.stats && typeof input.stats === "object" ? input.stats : {}),
      Math.max(0, Number(input?.findingsCount) || 0),
      Math.max(0, Number(input?.rejectionsCount) || 0),
      input?.error ? String(input.error).slice(0, 2_000) : null,
    ],
  );
}

function findingPayload(finding) {
  return {
    title: finding.title ?? null,
    legalStatusLabel: finding.legalStatusLabel ?? null,
    numbers: Array.isArray(finding.numbers) ? finding.numbers : [],
    corroboratingDomains: Array.isArray(finding.corroboratingDomains) ? finding.corroboratingDomains : [],
    tierLabel: finding.source?.tierLabel ?? null,
    registered: finding.source?.registered === true,
    trusted: finding.trusted === true,
    ageDays: Number(finding.ageDays) || 0,
    quote: String(finding.quote ?? "").slice(0, 4_000),
  };
}

/**
 * Сохраняет только прошедшие ворота факты. Повторный факт с тем же отпечатком не
 * создаёт дубль, но обновляет дату обнаружения — так карточка не мигает в выдаче.
 */
export async function persistWebResearchFindings(db, scope, runId, findings) {
  const { projectId, channelId } = requireScope(scope);
  let stored = 0;
  for (const finding of Array.isArray(findings) ? findings : []) {
    const fingerprint = String(finding?.fingerprint ?? "").slice(0, 80);
    const sourceUrl = String(finding?.source?.url ?? "");
    const publishedMs = Date.parse(String(finding?.publishedAt ?? ""));
    if (!fingerprint || !/^https?:\/\//u.test(sourceUrl) || !Number.isFinite(publishedMs)) continue;
    const result = await db.query(
      `insert into web_research_findings
         (run_id, project_id, channel_id, fingerprint, kind, claim, quote, legal_status, language,
          source_url, source_domain, source_label, source_tier, source_trust, published_at,
          corroboration_count, payload)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
       on conflict (project_id, channel_id, fingerprint) do update set
         run_id = excluded.run_id,
         claim = excluded.claim,
         quote = excluded.quote,
         legal_status = excluded.legal_status,
         source_trust = greatest(web_research_findings.source_trust, excluded.source_trust),
         corroboration_count = greatest(web_research_findings.corroboration_count, excluded.corroboration_count),
         payload = web_research_findings.payload || excluded.payload,
         retrieved_at = now()`,
      [
        positiveId(runId),
        projectId,
        channelId,
        fingerprint,
        finding.kind,
        String(finding.claim).slice(0, 600),
        String(finding.quote).slice(0, 4_000),
        finding.kind === "law" ? finding.legalStatus : null,
        finding.language === "EN" ? "EN" : "RU",
        sourceUrl,
        String(finding.source?.domain ?? "").slice(0, 253),
        finding.source?.label ? String(finding.source.label).slice(0, 300) : null,
        finding.source?.tier ?? "open",
        Math.max(0, Math.min(100, Number(finding.source?.trust) || 0)),
        new Date(publishedMs).toISOString(),
        Math.max(0, Number(finding.corroborationCount) || 0),
        JSON.stringify(findingPayload(finding)),
      ],
    );
    stored += result.rowCount ?? 0;
  }
  return stored;
}

export async function loadWebResearchFindings(db, scope, options = {}) {
  const { projectId, channelId } = requireScope(scope);
  const limit = Math.max(1, Math.min(200, Number(options.limit) || 20));
  const kinds = Array.isArray(options.kinds) && options.kinds.length ? options.kinds : null;
  const statuses = Array.isArray(options.statuses) && options.statuses.length ? options.statuses : ["new", "used"];
  const maxAgeDays = Math.max(1, Math.min(3_650, Number(options.maxAgeDays) || 180));
  const rows = (await db.query(
    `select id, run_id, fingerprint, kind, claim, quote, legal_status, language,
            source_url, source_domain, source_label, source_tier, source_trust,
            published_at::text, retrieved_at::text, corroboration_count, status, payload
       from web_research_findings
      where project_id = $1 and channel_id = $2
        and status = any($3::text[])
        and ($4::text[] is null or kind = any($4::text[]))
        and published_at >= now() - ($5::int * interval '1 day')
      order by source_trust desc, published_at desc, id desc
      limit $6`,
    [projectId, channelId, statuses, kinds, maxAgeDays, limit],
  )).rows;

  return rows.map((row) => {
    const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
    return {
      id: Number(row.id),
      runId: row.run_id ? Number(row.run_id) : null,
      fingerprint: row.fingerprint,
      kind: row.kind,
      claim: row.claim,
      quote: row.quote,
      title: typeof payload.title === "string" ? payload.title : null,
      language: row.language,
      legalStatus: row.legal_status,
      legalStatusLabel: typeof payload.legalStatusLabel === "string" ? payload.legalStatusLabel : null,
      source: {
        url: row.source_url,
        domain: row.source_domain,
        label: row.source_label || row.source_domain,
        tier: row.source_tier,
        tierLabel: typeof payload.tierLabel === "string" ? payload.tierLabel : "",
        trust: Number(row.source_trust) || 0,
        registered: payload.registered === true,
      },
      publishedAt: row.published_at,
      retrievedAt: row.retrieved_at,
      ageDays: Math.max(0, Math.floor((Date.now() - Date.parse(row.published_at)) / 86_400_000)),
      numbers: Array.isArray(payload.numbers) ? payload.numbers : [],
      corroboratingDomains: Array.isArray(payload.corroboratingDomains) ? payload.corroboratingDomains : [],
      corroborationCount: Number(row.corroboration_count) || 0,
      trusted: payload.trusted === true,
      status: row.status,
    };
  });
}

export async function markWebResearchFindings(db, scope, fingerprints, status) {
  const { projectId, channelId } = requireScope(scope);
  const allowed = ["new", "used", "dismissed"];
  if (!allowed.includes(status)) throw new WebResearchStoreError("bad_status");
  const list = [...new Set((Array.isArray(fingerprints) ? fingerprints : []).map((value) => String(value)).filter(Boolean))].slice(0, 200);
  if (!list.length) return 0;
  const result = await db.query(
    `update web_research_findings set status = $4
      where project_id = $1 and channel_id = $2 and fingerprint = any($3::text[])`,
    [projectId, channelId, list, status],
  );
  return result.rowCount ?? 0;
}

export async function latestWebResearchRun(db, scope) {
  const { projectId, channelId } = requireScope(scope);
  const row = (await db.query(
    `select id, trigger_kind, topic, categories, language, status, plan_fingerprint, queries, log, stats,
            findings_count, rejections_count, started_at::text, finished_at::text, error
       from web_research_runs
      where project_id = $1 and channel_id = $2
      order by started_at desc, id desc limit 1`,
    [projectId, channelId],
  )).rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    triggerKind: row.trigger_kind,
    topic: row.topic,
    categories: Array.isArray(row.categories) ? row.categories : [],
    language: row.language,
    status: row.status,
    planFingerprint: row.plan_fingerprint,
    queries: Array.isArray(row.queries) ? row.queries : [],
    log: Array.isArray(row.log) ? row.log : [],
    stats: row.stats && typeof row.stats === "object" ? row.stats : {},
    findingsCount: Number(row.findings_count) || 0,
    rejectionsCount: Number(row.rejections_count) || 0,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
  };
}

export async function getWebResearchRun(db, runId) {
  const id = positiveId(runId);
  if (!id) throw new WebResearchStoreError("bad_run");
  const rows = (await db.query(
    `select project_id, channel_id, trigger_kind, status, plan_fingerprint, queries
       from web_research_runs where id = $1`,
    [id],
  )).rows;
  const row = rows[0];
  if (!row) return null;
  return {
    id,
    projectId: Number(row.project_id),
    channelId: Number(row.channel_id),
    triggerKind: row.trigger_kind,
    status: row.status,
    planFingerprint: row.plan_fingerprint,
    queries: Array.isArray(row.queries) ? row.queries : [],
  };
}

/**
 * Кэш исследования: если такой же план уже отработал недавно, повторный выход в
 * интернет не нужен. Это экономит запросы и не даёт «Сегодня» дёргать поисковики
 * при каждом открытии экрана.
 */
export async function findReusableWebResearchRun(db, scope, planFingerprint, options = {}) {
  const { projectId, channelId } = requireScope(scope);
  const maxAgeMinutes = Math.max(1, Math.min(10_080, Number(options.maxAgeMinutes) || 720));
  const row = (await db.query(
    `select id from web_research_runs
      where project_id = $1 and channel_id = $2 and plan_fingerprint = $3
        and status = 'completed' and started_at >= now() - ($4::int * interval '1 minute')
      order by started_at desc, id desc limit 1`,
    [projectId, channelId, String(planFingerprint).slice(0, 80), maxAgeMinutes],
  )).rows[0];
  const runId = positiveId(row?.id);
  if (!runId) return null;
  return { runId, findings: await loadWebResearchFindings(db, scope, { limit: 40 }) };
}
