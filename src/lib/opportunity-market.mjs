import { createHash } from "node:crypto";

const STOP_WORDS = new Set([
  "аврора", "канал", "канала", "контент", "пост", "публикация", "аудитория",
  "который", "которая", "которые", "чтобы", "после", "перед", "только", "будет",
  "этот", "эта", "это", "или", "для", "про", "как", "что", "your", "with", "from",
]);

const sha = (value) => createHash("sha256").update(String(value), "utf8").digest("hex");

function clean(value, max = 2_000) {
  return String(value ?? "").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max);
}

function words(value) {
  const matches = clean(value).toLocaleLowerCase("ru-RU").replaceAll("ё", "е")
    .match(/[a-zа-я0-9]{4,}/gu) ?? [];
  return [...new Set(matches.filter((word) => !STOP_WORDS.has(word)).map((word) => word.slice(0, 8)))];
}

function bounded(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(Number(value) || 0)));
}

function ageHours(value, now = new Date()) {
  const time = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(time) ? Math.max(0, (now.getTime() - time) / 3_600_000) : 720;
}

function domainOf(value) {
  try { return new URL(value).hostname.toLocaleLowerCase("en-US").replace(/^www\./u, ""); }
  catch { return "unknown.invalid"; }
}

function firstLine(value, fallback = "Новая тема") {
  const text = clean(value, 400).replace(/^#+\s*/u, "").trim();
  const sentence = text.split(/(?<=[.!?])\s+/u)[0] || text;
  return sentence.length > 140 ? `${sentence.slice(0, 139).trimEnd()}…` : sentence || fallback;
}

export function researchProfile(input = {}) {
  const niche = clean(input.niche, 300);
  const audience = clean(input.audience, 500);
  const goal = clean(input.goal, 300);
  const taboo = clean(input.taboo, 500);
  const rubrics = Array.isArray(input.rubrics) ? input.rubrics.map((item) => clean(item, 120)).filter(Boolean).slice(0, 20) : [];
  const formats = Array.isArray(input.formats) ? input.formats.map((item) => clean(item, 80)).filter(Boolean).slice(0, 20) : [];
  const opportunityKeywords = Array.isArray(input.opportunityKeywords)
    ? input.opportunityKeywords.map((item) => clean(item, 80)).filter(Boolean).slice(0, 40) : [];
  const excludedKeywords = Array.isArray(input.excludedKeywords)
    ? input.excludedKeywords.map((item) => clean(item, 80)).filter(Boolean).slice(0, 40) : [];
  const profile = {
    niche, audience, goal, taboo, rubrics, formats, opportunityKeywords, excludedKeywords,
    language: clean(input.language || "ru", 16) || "ru",
    region: clean(input.region, 80) || null,
  };
  const searchText = [niche, audience, goal, ...rubrics, ...opportunityKeywords].filter(Boolean).join(" ");
  return { ...profile, searchText, terms: words(searchText), excludedTerms: words([taboo, ...excludedKeywords].join(" ")), hash: sha(JSON.stringify(profile)) };
}

export function marketRelevance(profile, text) {
  const candidate = new Set(words(text));
  if (!profile?.terms?.length || candidate.size === 0) return 0;
  if (profile.excludedTerms?.some((term) => candidate.has(term))) return -1;
  const matches = profile.terms.filter((term) => candidate.has(term)).length;
  const denominator = Math.max(1, Math.min(profile.terms.length, 8));
  return bounded((matches / denominator) * 100);
}

export function opportunityTypeFor(sourceKind, publishedAt, now = new Date()) {
  if (sourceKind === "rss_item" || sourceKind === "news_event") {
    return ageHours(publishedAt, now) <= 168 ? "breaking_news" : "rising_topic";
  }
  if (sourceKind === "competitor_post") return "competitor_gap";
  if (sourceKind === "audience_question") return "audience_need";
  if (sourceKind === "site_analysis") return "offer_gap";
  return sourceKind === "channel_profile" ? "evergreen_gap" : "rising_topic";
}

export function opportunityWindow(type, observedAt, now = new Date()) {
  const base = observedAt && Number.isFinite(new Date(observedAt).getTime()) ? new Date(observedAt) : now;
  const hours = type === "breaking_news" ? 72
    : type === "rising_topic" || type === "competitor_gap" ? 7 * 24
      : type === "audience_need" || type === "offer_gap" ? 14 * 24 : 30 * 24;
  const expiresAt = new Date(base.getTime() + hours * 3_600_000);
  const publishBefore = type === "breaking_news" ? new Date(Math.min(expiresAt.getTime(), now.getTime() + 24 * 3_600_000))
    : type === "rising_topic" ? new Date(Math.min(expiresAt.getTime(), now.getTime() + 72 * 3_600_000))
      : null;
  return { expiresAt, publishBefore };
}

export function opportunityPriority(input) {
  const relevance = bounded(input.relevance);
  const momentum = bounded(input.momentum);
  const freshness = bounded(input.freshness);
  const whitespace = bounded(input.whitespace);
  const fit = bounded(input.fit);
  const evidence = bounded(input.evidence);
  const score = relevance * 0.30 + momentum * 0.20 + freshness * 0.15
    + whitespace * 0.15 + fit * 0.10 + evidence * 0.10;
  return bounded(score);
}

export function freshnessScore(value, now = new Date()) {
  const hours = ageHours(value, now);
  if (hours <= 6) return 100;
  if (hours <= 24) return 90;
  if (hours <= 72) return 75;
  if (hours <= 168) return 60;
  if (hours <= 720) return 35;
  return 10;
}

export async function syncPublicMarketSignals(db) {
  const locked = (await db.query("select pg_try_advisory_lock(hashtextextended('market-signals-sync-v2', 0)) as locked")).rows[0]?.locked === true;
  if (!locked) return { synchronized: 0, skipped: true };
  let synchronized = 0;
  try {
    const trendRows = (await db.query(
      `select post.id, post.tg_msg_id, post.text, post.views, post.posted_at::text, post.collected_at::text,
              source.handle, source.title as source_title, source.subscribers
         from trend_posts post join trend_sources source on source.id = post.source_id
        where source.enabled = true and post.posted_at >= now() - interval '30 days'
          and length(btrim(coalesce(post.text, ''))) >= 12
        order by post.posted_at desc limit 500`,
    )).rows;
    for (const row of trendRows) {
      const url = `https://t.me/${String(row.handle).replace(/^@/u, "")}/${row.tg_msg_id}`;
      const title = firstLine(row.text);
      const views = Number(row.views) || 0;
      const subscribers = Math.max(1, Number(row.subscribers) || views || 1);
      const momentum = bounded(35 + Math.min(50, (views / subscribers) * 100));
      synchronized += await upsertPublicSignal(db, {
        key: `trend-post:${row.id}`, kind: "public_post", title, summary: clean(row.text, 1_200),
        publishedAt: row.posted_at, lastSeenAt: row.collected_at, momentum, trust: 65,
        provider: "telegram-public-trends", url, sourceTitle: row.source_title || `@${row.handle}`,
        rawMetadata: { trendPostId: Number(row.id), views },
      });
    }

    const webRows = (await db.query(
      `select id, canonical_url, domain, source_kind, title, description, content_sample,
              provider, trust_score, first_seen_at::text, last_seen_at::text, verified_at::text
         from radar_public_sources
        where verification_status in ('fetched','search_index')
          and last_seen_at >= now() - interval '30 days'
          and trust_score >= 25
          and length(btrim(coalesce(title, description, content_sample, ''))) >= 12
        order by last_seen_at desc, trust_score desc limit 500`,
    )).rows;
    for (const row of webRows) {
      const title = firstLine(row.title || row.description || row.content_sample);
      const kind = row.source_kind === "article" && ageHours(row.first_seen_at) <= 168 ? "news" : "public_post";
      synchronized += await upsertPublicSignal(db, {
        key: `public-web:${row.canonical_url}`, kind, title,
        summary: clean(row.description || row.content_sample, 1_200),
        publishedAt: row.verified_at || row.first_seen_at, lastSeenAt: row.last_seen_at,
        momentum: kind === "news" ? 60 : 40, trust: bounded(row.trust_score),
        provider: row.provider || "radar-public-index", url: row.canonical_url,
        sourceTitle: row.domain, rawMetadata: { radarPublicSourceId: Number(row.id) },
      });
    }
    await db.query("update market_signals set status='stale' where status='active' and last_seen_at < now() - interval '30 days'");
    return { synchronized, skipped: false };
  } finally {
    await db.query("select pg_advisory_unlock(hashtextextended('market-signals-sync-v2', 0))").catch(() => undefined);
  }
}

async function upsertPublicSignal(db, input) {
  const topics = words(`${input.title} ${input.summary}`).slice(0, 30);
  const eventKey = words(input.title).slice(0, 14).join(":");
  const canonicalHash = sha(eventKey.length >= 8 ? `event:${eventKey}` : input.key);
  const signal = (await db.query(
    `insert into market_signals
       (kind, canonical_hash, title, summary, topic_keys, momentum_score, trust_score,
        published_at, last_seen_at, status, raw_metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10::jsonb)
     on conflict (canonical_hash) do update set
       kind=case when excluded.kind='news' then 'news' else market_signals.kind end,
       title=excluded.title, summary=excluded.summary, topic_keys=excluded.topic_keys,
       momentum_score=excluded.momentum_score, trust_score=greatest(market_signals.trust_score, excluded.trust_score),
       published_at=coalesce(excluded.published_at, market_signals.published_at),
       last_seen_at=greatest(market_signals.last_seen_at, excluded.last_seen_at), status='active',
       raw_metadata=market_signals.raw_metadata || excluded.raw_metadata
     returning id`,
    [input.kind, canonicalHash, input.title, input.summary, topics, bounded(input.momentum), bounded(input.trust),
      input.publishedAt || null, input.lastSeenAt || new Date(), JSON.stringify(input.rawMetadata || {})],
  )).rows[0];
  if (!signal) return 0;
  await db.query(
    `insert into market_signal_sources
       (signal_id, provider, source_url, source_url_hash, source_domain, source_title, published_at, trust_score, raw_metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
     on conflict (signal_id, source_url_hash) do update set
       fetched_at=now(), source_title=excluded.source_title,
       published_at=coalesce(excluded.published_at, market_signal_sources.published_at),
       trust_score=greatest(market_signal_sources.trust_score, excluded.trust_score),
       raw_metadata=market_signal_sources.raw_metadata || excluded.raw_metadata`,
    [Number(signal.id), clean(input.provider, 80), input.url, sha(input.url), domainOf(input.url), clean(input.sourceTitle, 300) || null,
      input.publishedAt || null, bounded(input.trust), JSON.stringify(input.rawMetadata || {})],
  );
  return 1;
}

export async function loadChannelMarketCandidates(db, scope, profile, now = new Date()) {
  if (!profile?.niche && !profile?.rubrics?.length && !profile?.opportunityKeywords?.length) return [];
  const rows = (await db.query(
    `select signal.id, signal.kind, signal.title, signal.summary, signal.momentum_score,
            signal.trust_score, signal.published_at::text, signal.last_seen_at::text,
            count(source.id)::int as source_count,
            coalesce(jsonb_agg(jsonb_build_object('url',source.source_url,'label',coalesce(source.source_title,source.source_domain),'trust',source.trust_score)
              order by source.trust_score desc, source.id) filter (where source.id is not null), '[]'::jsonb) as sources
       from market_signals signal
       left join market_signal_sources source on source.signal_id = signal.id
      where signal.status = 'active' and signal.last_seen_at >= now() - interval '30 days'
        and (signal.language = $1 or signal.language = 'und')
      group by signal.id
      order by signal.last_seen_at desc, signal.trust_score desc limit 500`,
    [profile.language || "ru"],
  )).rows;
  const candidates = [];
  for (const row of rows) {
    const relevance = marketRelevance(profile, `${row.title} ${row.summary}`);
    if (relevance < 25) continue;
    const observedAt = row.published_at || row.last_seen_at;
    const fresh = freshnessScore(observedAt, now);
    const sourceCount = Number(row.source_count) || 0;
    const priority = opportunityPriority({
      relevance: Math.max(35, relevance), momentum: row.momentum_score, freshness: fresh,
      whitespace: 75, fit: profile.formats.length ? 80 : 65,
      evidence: Math.min(100, Number(row.trust_score) + Math.min(25, sourceCount * 8)),
    });
    const type = row.kind === "news" ? "breaking_news" : row.kind === "evergreen_gap" ? "evergreen_gap" : "rising_topic";
    const window = opportunityWindow(type, observedAt, now);
    if (window.expiresAt.getTime() <= now.getTime()) continue;
    candidates.push({
      sourceKind: row.kind === "news" ? "news_event" : "market_signal", sourceId: String(row.id),
      sourceLabel: Array.isArray(row.sources) && row.sources[0]?.label ? clean(row.sources[0].label, 160) : "Открытые источники",
      title: firstLine(row.title), summary: clean(row.summary, 800), observedAt, type, priority,
      sourceCount, sources: Array.isArray(row.sources) ? row.sources.slice(0, 8) : [], relevance,
      momentum: bounded(row.momentum_score), freshness: fresh, trust: bounded(row.trust_score),
      profileHash: profile.hash, publishBefore: window.publishBefore?.toISOString() ?? null,
      expiresAt: window.expiresAt.toISOString(),
    });
  }
  const clustered = new Map();
  for (const candidate of candidates) {
    const key = words(candidate.title).slice(0, 14).join(":") || `${candidate.sourceKind}:${candidate.sourceId}`;
    const previous = clustered.get(key);
    if (!previous) {
      clustered.set(key, candidate);
      continue;
    }
    const primary = candidate.priority > previous.priority ? candidate : previous;
    const sourceByUrl = new Map(
      [...previous.sources, ...candidate.sources]
        .filter((source) => source?.url)
        .map((source) => [source.url, source]),
    );
    const sources = [...sourceByUrl.values()]
      .sort((left, right) => Number(right.trust ?? 0) - Number(left.trust ?? 0))
      .slice(0, 8);
    clustered.set(key, {
      ...primary,
      sources,
      sourceCount: sources.length || Math.max(previous.sourceCount, candidate.sourceCount),
      priority: bounded(Math.max(previous.priority, candidate.priority) + Math.min(6, Math.max(0, sources.length - 1) * 2)),
      trust: Math.max(previous.trust, candidate.trust),
      momentum: Math.max(previous.momentum, candidate.momentum),
      freshness: Math.max(previous.freshness, candidate.freshness),
    });
  }
  return [...clustered.values()]
    .sort((left, right) => right.priority - left.priority || String(right.observedAt).localeCompare(String(left.observedAt)))
    .slice(0, 7);
}

export function buildProfileFallbackCandidates(profile, now = new Date()) {
  if (!profile?.niche && !profile?.rubrics?.length) return [];
  const subjects = [...new Set([...profile.rubrics, profile.niche].map((item) => clean(item, 120)).filter(Boolean))];
  const base = subjects[0] || profile.niche;
  const templates = [
    ["Практический вопрос", `Ответьте на главный практический вопрос аудитории о теме «${base}»`, "Покажите проблему, короткий ответ и следующий шаг."],
    ["Чек-лист", `Соберите чек-лист по теме «${base}»`, "Дайте последовательность действий, которую можно сохранить и применить."],
    ["Типичная ошибка", `Разберите типичную ошибку в теме «${base}»`, "Объясните последствие ошибки и безопасный способ её избежать."],
    ["Сравнение", `Сравните два подхода в теме «${base}»`, "Покажите, кому подходит каждый вариант и по каким критериям выбирать."],
    ["Практический пример", `Покажите практический пример по теме «${base}»`, "Разберите исходную ситуацию, решение и ограничение без обещания результата."],
  ];
  const window = opportunityWindow("evergreen_gap", now, now);
  return templates.map(([label, title, angle], index) => ({
    sourceKind: "channel_profile", sourceId: sha(`${profile.hash}:${label}`), sourceLabel: "Профиль канала",
    title, summary: angle, observedAt: now.toISOString(), type: "evergreen_gap", priority: 46 - index,
    sourceCount: 0, sources: [], relevance: 75, momentum: 20, freshness: 100, trust: 40,
    profileHash: profile.hash, publishBefore: null, expiresAt: window.expiresAt.toISOString(),
  }));
}
