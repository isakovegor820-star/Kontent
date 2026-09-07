import { requireSiteAiAccess, withSiteAiAccess, siteAiScope } from "./site-ai-access.mjs";
import { rssAccessSql } from "./rss-access.mjs";
import { Worker } from "bullmq";
import { randomUUID } from "node:crypto";

import { completeAiText } from "../src/lib/ai-completion-service.mjs";
import { configuredServiceEngine } from "../src/lib/ai-engine-policy.mjs";
import { buildArticlePrompt, parseArticleGeneration, validateArticle } from "../src/lib/site-articles/generation.mjs";
import { markdownToText } from "../src/lib/site-articles/markdown.mjs";
import {
  SITE_ARTICLE_FIELDS,
  activeDestinationsForSite,
  articlePayload,
  createArticlePublications,
  nextUniqueSlug,
  recordArticleRevision,
} from "../src/lib/site-articles/service.mjs";
import { checkSimilarity } from "../src/lib/site-articles/similarity.mjs";
import { normalizeSiteCadence, planArticleCandidates, sourceKeyFor } from "../src/lib/site-articles/types.mjs";
import { createSiteDestinationAdapters, destinationRuntime } from "../src/lib/site-destinations/index.mjs";
import { assertWorkerAiCallPolicy } from "./ai-call-policy.mjs";
import {
  WORKER_AI_RESERVATION_TTL_MS,
  acquireWorkerAiUsage,
  commitWorkerAiUsage,
  releaseWorkerAiUsage,
  workerAiUsageCompositeKey,
} from "./ai-usage-reservation.mjs";
import { createEmbedder, toVector } from "./embeddings.mjs";
import { runSiteVisibilityProbe } from "./site-visibility-probe.mjs";
import { runSiteReportOnDemand } from "./site-scheduler.mjs";
import { interpretSiteReport, refineSiteProfile } from "./site-ai-worker.mjs";

export const SITE_ARTICLES_QUEUE = "site-articles";
export const SITE_ARTICLE_JOBS = Object.freeze({
  PLAN: "plan", GENERATE: "generate", PUBLISH: "publish", RECONCILE: "reconcile", PROBE: "probe", REPORT: "report",
  REFINE: "refine", INTERPRET: "interpret",
});

const MAX_PUBLISH_ATTEMPTS = 3;
const GENERATION_MAX_TOKENS = 3_500;

export class SiteArticleWorkerError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = "SiteArticleWorkerError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function siteArticleJobId(name, id) {
  return `site-articles-${name}-${id}`;
}

export async function enqueueSiteArticleJob(queue, name, data, { delayMs = 0, jobId = null } = {}) {
  const id = jobId || siteArticleJobId(name, data.articleId ?? data.publicationId ?? data.profileId ?? data.reportId ?? data.siteId ?? randomUUID());
  await queue.add(name, data, {
    jobId: id,
    delay: delayMs,
    attempts: name === SITE_ARTICLE_JOBS.PUBLISH ? 1 : 2,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  });
  return id;
}

async function loadSite(db, siteId) {
  const result = await db.query(
    `select s.id, s.project_id, s.user_id, s.confirmed_domain, s.canonical_url, s.verification_state, s.status,
            s.publishing_mode, s.auto_unlock_streak, s.approved_streak, s.cadence, s.hosted_slug, s.brand_name,
            s.latest_profile_id, s.latest_analysis_id,
            p.topics, p.gaps, p.linkable_pages, p.technical, p.summary
       from sites s
       left join site_profiles p on p.id = s.latest_profile_id and p.site_id = s.id
      where s.id = $1`,
    [siteId],
  );
  return result.rows[0] || null;
}

function profileFromSite(site) {
  return {
    topics: Array.isArray(site.topics) ? site.topics : [],
    gaps: Array.isArray(site.gaps) ? site.gaps : [],
    linkablePages: Array.isArray(site.linkable_pages) ? site.linkable_pages : [],
    technical: site.technical || {},
    summary: site.summary || null,
  };
}

// ─── Планирование ────────────────────────────────────────────────────────────

/** @param {import("pg").Pool} pool
 * @param {{siteId:number, requestedByUserId?:number|null}} input
 * @param {Record<string, any>} dependencies */
export async function planSiteArticles(pool, { siteId, requestedByUserId = null }, dependencies = {}) {
  const scope = await siteAiScope(pool, siteId, requestedByUserId);
  let site;
  try { site = await withSiteAiAccess(pool, scope, (client) => loadSite(client, siteId)); }
  catch (error) { if (String(error?.code || "").startsWith("ai_work_")) return { planned: 0, reason: "project_access_denied" }; throw error; }
  if (!site || !site.latest_profile_id) return { planned: 0, reason: "site_not_ready" };
  const requester=scope.userId;
  if(!(await pool.query(`select 1 where ${rssAccessSql("$1","$2")}`,[site.project_id,requester])).rowCount)return {planned:0,reason:"project_access_denied"};
  const profile = profileFromSite(site);
  const cadence = normalizeSiteCadence(site.cadence);

  const [questions, rss, posts, existing, weekCounts, pending] = await withSiteAiAccess(pool, scope, async (pool) => [
    await pool.query(
      `select id, question, occurrences from audience_questions
        where project_id = $1 and status in ('new', 'planned')
        order by occurrences desc, last_seen_at desc limit 20`,
      [site.project_id],
    ),
    await pool.query(
      `select i.id, i.title, i.summary, i.link, i.published_at
         from rss_items i join rss_feeds f on f.id = i.feed_id
         join channels rss_channel on rss_channel.id=f.channel_id and rss_channel.project_id=f.project_id and f.project_id=$2
        where f.user_id = $1 and f.is_active and i.status <> 'skipped'
          and ${rssAccessSql("rss_channel.project_id","f.user_id")}
          and i.fetched_at >= now() - interval '7 days'
        order by i.published_at desc nulls last, i.id desc limit 30`,
      [site.user_id,site.project_id],
    ),
    await pool.query(
      `select p.id, p.text, p.media, p.published_at
         from posts p join channels c on c.id = p.channel_id
        where c.project_id = $1 and p.status = 'published'
          and p.published_at >= now() - interval '14 days'
        order by p.published_at desc limit 30`,
      [site.project_id],
    ),
    await pool.query(`select source_key from site_articles where site_id = $1 and source_key is not null`, [siteId]),
    await pool.query(
      `select article_type, count(*)::int as n from site_articles
        where site_id = $1 and status <> 'rejected'
          and created_at >= date_trunc('week', (now() at time zone 'Europe/Moscow')) at time zone 'Europe/Moscow'
        group by article_type`,
      [siteId],
    ),
    await pool.query(`select count(*)::int as n from site_articles where site_id = $1 and status in ('draft', 'generating', 'needs_review')`, [siteId]),
  ]);

  const createdThisWeekByType = Object.fromEntries(weekCounts.rows.map((row) => [row.article_type, Number(row.n)]));
  const planned = planArticleCandidates({
    profile,
    cadence,
    sources: {
      audienceQuestions: questions.rows.map((row) => ({ id: Number(row.id), question: row.question, occurrences: Number(row.occurrences) })),
      rssItems: rss.rows.map((row) => ({ id: Number(row.id), title: row.title, summary: row.summary, url: row.link, publishedAt: row.published_at })),
      channelPosts: posts.rows.map((row) => ({ id: Number(row.id), text: row.text, media: Array.isArray(row.media) ? row.media : [], publishedAt: row.published_at })),
    },
    createdThisWeekByType,
    existingSourceKeys: new Set(existing.rows.map((row) => row.source_key)),
    pendingReview: Number(pending.rows[0]?.n || 0),
  });

  const created = [];
  for (const candidate of planned) {
    const sourceRef = candidate.origin === "gap"
      ? { kind: "gap", key: candidate.source.key, gapKind: candidate.source.kind, question: candidate.source.label, evidenceUrls: candidate.source.evidenceUrls || [] }
      : candidate.origin === "audience_question"
        ? { kind: "audience_question", id: candidate.source.id, question: candidate.source.question }
        : candidate.origin === "rss"
          ? { kind: "rss", id: candidate.source.id, title: candidate.source.title, summary: candidate.source.summary, url: candidate.source.url, publishedAt: candidate.source.publishedAt }
          : { kind: "channel_post", id: candidate.source.id, text: candidate.source.text, publishedAt: candidate.source.publishedAt, mediaCount: candidate.source.media?.length || 0 };
    const placeholderSlug = `draft-${randomUUID().slice(0, 8)}`;
    const inserted = await withSiteAiAccess(pool, scope, (client) => client.query(
      `insert into site_articles (site_id, project_id, user_id, article_type, origin, source_key, source_ref, slug, status)
       select $1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'draft'
       where ${rssAccessSql("$2","$3")}
         and exists(select 1 from sites current_site where current_site.id=$1 and current_site.project_id=$2 and current_site.status='active')
       on conflict (site_id, source_key) where source_key is not null do nothing
       returning id`,
      [siteId, site.project_id, requestedByUserId ?? site.user_id, candidate.type, candidate.origin, candidate.sourceKey || sourceKeyFor(candidate.origin, candidate.source), JSON.stringify(sourceRef), placeholderSlug],
    ));
    if (inserted.rows[0]) created.push(Number(inserted.rows[0].id));
  }
  if (dependencies.queue) {
    for (const articleId of created) await enqueueSiteArticleJob(dependencies.queue, SITE_ARTICLE_JOBS.GENERATE, { articleId });
  }
  return { planned: created.length, articleIds: created };
}

// ─── Генерация ───────────────────────────────────────────────────────────────

async function siteFacts(pool, siteId, queryText) {
  const words = String(queryText || "").toLowerCase().replace(/[^\wа-яё\s]/giu, " ").split(/\s+/u).filter((word) => word.length > 3).slice(0, 24);
  if (!words.length) return [];
  const result = await pool.query(
    `select c.text from knowledge_chunks c
       join knowledge_sources s on s.id = c.source_id
      where c.site_id = $1 and c.kind <> 'voice' and s.kind in ('site_page', 'paste', 'form', 'profile', 'profile_edit')
        and c.tsv @@ to_tsquery('russian', $2)
      order by ts_rank(c.tsv, to_tsquery('russian', $2)) desc limit 12`,
    [siteId, words.join(" | ")],
  ).catch(() => ({ rows: [] }));
  return result.rows.map((row) => row.text);
}

async function similarityCorpus(pool, site) {
  const pages = site.latest_analysis_id
    ? await pool.query(
      `select url, title, main_content from site_analysis_pages
        where analysis_id = $1 and main_content is not null and length(main_content) >= 400
        order by id limit 200`,
      [site.latest_analysis_id],
    )
    : { rows: [] };
  const published = await pool.query(
    `select published_url as url, slug, title, body_markdown from site_articles
      where site_id = $1 and status = 'published' order by published_at desc limit 200`,
    [site.id],
  );
  return [
    ...pages.rows.map((row) => ({ url: row.url, text: `${row.title || ""} ${row.main_content}` })),
    ...published.rows.map((row) => ({ url: row.url || row.slug, text: `${row.title} ${markdownToText(row.body_markdown)}` })),
  ];
}

async function vectorScores(pool, site, embed, text) {
  if (typeof embed !== "function") return null;
  const vector = await embed(text.slice(0, 6_000), { pool,userId:Number(site.user_id),projectId:Number(site.project_id) });
  if (!vector) return null;
  const result = await pool.query(
    `select s.title as url, 1 - (c.embedding <=> $2::vector) as score
       from knowledge_chunks c join knowledge_sources s on s.id = c.source_id
      where c.site_id = $1 and c.embedding is not null and s.kind in ('site_page', 'site_publication')
      order by c.embedding <=> $2::vector limit 3`,
    [site.id, toVector(vector)],
  ).catch(() => ({ rows: [] }));
  return result.rows.map((row) => ({ url: row.url, score: Number(row.score) }));
}

function sourceForPrompt(article) {
  const ref = article.source_ref || {};
  switch (ref.kind) {
    case "rss": return { kind: "news", title: ref.title, summary: ref.summary, url: ref.url, publishedAt: ref.publishedAt };
    case "audience_question": return { kind: "question", question: ref.question };
    case "gap": return { kind: "gap", question: ref.question, text: ref.gapKind };
    case "channel_post": return { kind: "channel_post", text: ref.text, publishedAt: ref.publishedAt };
    case "manual": return { kind: "manual", text: ref.brief, question: ref.question, title: ref.title };
    default: return { kind: "none" };
  }
}

async function autoPublishIfUnlocked(client, site, articleRow, queue) {
  const unlocked = site.publishing_mode === "auto" && Number(site.approved_streak) >= Number(site.auto_unlock_streak);
  if (!unlocked) return { autoPublished: false };
  const destinations = await activeDestinationsForSite(client, site.id);
  if (!destinations.length || site.verification_state !== "verified") return { autoPublished: false, reason: "no_destination_or_unverified" };
  await client.query(
    `update site_articles set status = 'approved', approved_by = $2, approved_version = version, approved_at = now(), updated_at = now() where id = $1`,
    [articleRow.id, site.user_id],
  );
  const publications = await createArticlePublications(client, { article: articleRow, destinations, action: "publish", requestedByUserId: Number(site.user_id) });
  if (queue) for (const publication of publications) await enqueueSiteArticleJob(queue, SITE_ARTICLE_JOBS.PUBLISH, { publicationId: Number(publication.id) });
  return { autoPublished: true, publications: publications.length };
}

export async function generateSiteArticle(pool, { articleId }, dependencies = {}) {
  const complete = dependencies.completeAiText || completeAiText;
  const acquire = dependencies.acquireUsage || acquireWorkerAiUsage;
  const commit = dependencies.commitUsage || commitWorkerAiUsage;
  const release = dependencies.releaseUsage || releaseWorkerAiUsage;
  const embed = dependencies.embed === undefined ? createEmbedder(dependencies.env || process.env) : dependencies.embed;

  const identity = (await pool.query(`select site_id, project_id, coalesce(generation_requested_by_user_id,user_id) as user_id
    from site_articles where id=$1 and status in ('draft','failed')`, [articleId])).rows[0];
  if (!identity) return { ok: true, skipped: "not_generatable" };
  const scope = { siteId: Number(identity.site_id), projectId: Number(identity.project_id), userId: Number(identity.user_id) };
  const context = await withSiteAiAccess(pool, scope, async (client) => {
    const claimed = await client.query(
      `update site_articles set status = 'generating', updated_at = now()
        where id = $1 and status in ('draft', 'failed')
          and site_id=$2 and project_id=$3 and coalesce(generation_requested_by_user_id,user_id)=$4
        returning ${SITE_ARTICLE_FIELDS}`,
      [articleId, scope.siteId, scope.projectId, scope.userId],
    );
    const article = claimed.rows[0];
    if (!article) return null;
    const site = await loadSite(client, article.site_id);
    const source = sourceForPrompt(article);
    const facts = await siteFacts(client, site.id, `${source.title || ""} ${source.question || ""} ${source.text || ""}`);
    return { article, site, source, facts };
  });
  if (!context) return { ok: true, skipped: "not_generatable" };
  const { article, site, source, facts } = context;
  const accountingUserId = scope.userId;
  const profile = profileFromSite(site);
  const siteInfo = { confirmedDomain: site.confirmed_domain, brandName: site.brand_name, canonicalUrl: site.canonical_url };

  const usage = await acquire(pool, {
    userId: accountingUserId,
    kind: "site_article",
    key: workerAiUsageCompositeKey("site-article", [String(articleId), `v${article.version}`]),
    ttlMs: WORKER_AI_RESERVATION_TTL_MS,
  });
  if (usage.state === "limit") {
    await pool.query(`update site_articles set status = 'draft', status_reason = 'ai_usage_limit', updated_at = now() where id = $1`, [articleId]);
    throw new SiteArticleWorkerError("ai_usage_limit", "Лимит ИИ на сегодня исчерпан.", { retryable: true });
  }
  if (usage.state === "in_progress") throw new SiteArticleWorkerError("generation_in_progress", "Материал уже генерируется.", { retryable: true });
  const reservationId = Number(usage.reservationId);
  assertWorkerAiCallPolicy("site-article", reservationId);

  try {
    const engine = configuredServiceEngine(dependencies.engine ?? process.env.SITE_ARTICLES_ENGINE ?? null);
    const prompt = buildArticlePrompt({ type: article.article_type, site: siteInfo, profile, source, linkablePages: profile.linkablePages, facts });
    let validation = null;
    let completion = null;
    let feedback = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      completion = await complete({
        system: prompt.system,
        user: feedback ? `${prompt.user}\n\nПРЕДЫДУЩАЯ ПОПЫТКА ОТКЛОНЕНА. Исправь:\n${feedback}` : prompt.user,
        engine,
        temperature: 0.4,
        maxTokens: GENERATION_MAX_TOKENS,
        providerRequestKey: `site-article:${articleId}:v${article.version}:a${attempt}`,
      }, { allowFallback: true, timeoutMs: 120_000, spendScope: { pool, userId: accountingUserId, projectId: Number(site.project_id) } });
      let parsed;
      try {
        parsed = parseArticleGeneration(completion.text);
      } catch (error) {
        feedback = `Ответ не является JSON нужной формы (${error.message}).`;
        continue;
      }
      validation = validateArticle(parsed, {
        type: article.article_type,
        allowedLinks: profile.linkablePages.map((page) => page.url),
        sourceUrl: article.source_ref?.url || null,
        site: siteInfo,
      });
      if (validation.ok) break;
      feedback = validation.issues.filter((issue) => issue.severity === "error").map((issue) => `- ${issue.message}`).join("\n");
    }

    const generation = { promptVersion: prompt.promptVersion, engine: completion?.engine || engine, fallbackUsed: completion?.fallbackUsed || false, attempts: completion?.attempts || null };
    if (!validation || !validation.ok) {
      await withSiteAiAccess(pool, scope, (client) => client.query(
        `update site_articles set status = 'failed', status_reason = 'quality', quality = $2::jsonb, generation = $3::jsonb, updated_at = now() where id = $1`,
        [articleId, JSON.stringify({ issues: validation?.issues || [{ code: "schema_invalid", severity: "error", message: feedback }] }), JSON.stringify(generation)],
      ));
      await commit(pool, accountingUserId, reservationId);
      return { ok: false, reason: "quality", issues: validation?.issues || [] };
    }

    const candidateText = `${validation.article.title} ${markdownToText(validation.article.bodyMarkdown)}`;
    const similarity = checkSimilarity({
      candidateText,
      corpus: await withSiteAiAccess(pool, scope, (client) => similarityCorpus(client, site)),
      vectorScores: await vectorScores(pool, { ...site, user_id: accountingUserId }, embed, candidateText),
    });

    const client = await pool.connect();
    try {
      await client.query("begin");
      await requireSiteAiAccess(client, scope);
      const slug = await nextUniqueSlug(client, { siteId: site.id, base: validation.article.slug, excludeArticleId: articleId });
      const status = similarity.verdict === "reject" ? "rejected" : "needs_review";
      const statusReason = similarity.verdict === "reject" ? "semantic_duplicate" : similarity.verdict === "warn" ? "similarity_warning" : null;
      const updated = await client.query(
        `update site_articles
            set title = $2, slug = $3, meta_description = $4, body_markdown = $5, body_html = $6,
                internal_links = $7::jsonb, structured_data = $8::jsonb, similarity_check = $9::jsonb,
                quality = $10::jsonb, generation = $11::jsonb, status = $12, status_reason = $13, updated_at = now()
          where id = $1
          returning ${SITE_ARTICLE_FIELDS}`,
        [
          articleId, validation.article.title, slug, validation.article.metaDescription, validation.article.bodyMarkdown,
          validation.article.bodyHtml, JSON.stringify(validation.article.internalLinks),
          validation.article.structuredData ? JSON.stringify(validation.article.structuredData) : null,
          JSON.stringify(similarity), JSON.stringify({ issues: validation.issues, wordCount: validation.article.wordCount }),
          JSON.stringify(generation), status, statusReason,
        ],
      );
      const row = updated.rows[0];
      await recordArticleRevision(client, { article: row, version: row.version, authorUserId: null, changeKind: "generated" });
      let auto = { autoPublished: false };
      if (status === "needs_review") auto = await autoPublishIfUnlocked(client, site, row, dependencies.queue);
      await client.query("commit");
      await commit(pool, accountingUserId, reservationId);
      return { ok: true, articleId, status: auto.autoPublished ? "approved" : status, similarity: similarity.verdict, ...auto };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    if (!(error instanceof SiteArticleWorkerError)) {
      await release(pool, accountingUserId, reservationId).catch(() => undefined);
      const code = typeof error?.code === "string" ? error.code : "generation_failed";
      await pool.query(
        `update site_articles set status = 'failed', status_reason = $2, updated_at = now() where id = $1 and status = 'generating'`,
        [articleId, code.slice(0, 80)],
      );
    }
    throw error;
  }
}

// ─── Публикация ──────────────────────────────────────────────────────────────

async function loadPublication(db, publicationId) {
  const result = await db.query(
    `select p.*, a.site_id, a.user_id, a.version as current_version, a.status as article_status
       from site_article_publications p join site_articles a on a.id = p.article_id
      where p.id = $1`,
    [publicationId],
  );
  return result.rows[0] || null;
}

function sitePublicationAuthority(publicationParameter, expectedParameter = null) {
  return `with authorized as materialized (
    select publication.id, article.id as article_id
      from site_article_publications publication
      join site_articles article on article.id = publication.article_id
      join sites site on site.id = article.site_id and site.project_id = article.project_id
        and site.status = 'active' and site.verification_state = 'verified'
      join site_destinations destination on destination.id = publication.destination_id
        and destination.site_id = site.id and destination.status = 'active'
        and destination.credential_state in ('ready','not_required')
      join projects project on project.id = article.project_id and not project.is_archived
      join project_members member on member.project_id = project.id
        and member.user_id = publication.requested_by_user_id and member.status = 'active'
        and member.role in ('owner','publisher')
      join users actor on actor.id = member.user_id and actor.blocked_at is null
     where publication.id = ${publicationParameter}
       ${expectedParameter ? `and jsonb_build_object('base_url',destination.base_url,
         'credentials',destination.credentials,'section_path',destination.section_path,
         'settings',destination.settings,'kind',destination.kind) = ${expectedParameter}::jsonb` : ""}
     for share of project, member, actor, site, destination
  )`;
}

export async function publishSiteArticle(pool, { publicationId }, dependencies = {}) {
  const adapters = dependencies.adapters || createSiteDestinationAdapters();
  const leaseToken = randomUUID();
  const claimed = await pool.query(
    `${sitePublicationAuthority("$1")}
     update site_article_publications
        set status = 'publishing', attempts = attempts + 1, worker_lease_token = $2, updated_at = now()
      where id = $1 and id in (select id from authorized) and status = 'pending' and attempts < $3
      returning id`,
    [publicationId, leaseToken, MAX_PUBLISH_ATTEMPTS],
  );
  if (!claimed.rows[0]) return { ok: true, skipped: "not_pending" };
  const publication = await loadPublication(pool, publicationId);
  const site = await loadSite(pool, publication.site_id);
  let article = (await pool.query(`select ${SITE_ARTICLE_FIELDS} from site_articles where id = $1`, [publication.article_id])).rows[0];
  const destinationRow = (await pool.query(
    `select id, site_id, kind, base_url, credentials, credential_state, section_path, settings, status from site_destinations where id = $1`,
    [publication.destination_id],
  )).rows[0];

  const fail = async (code, { articleStatus = "failed", synchronize = false } = {}) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const current = (await client.query("select id, version, status from site_articles where id = $1 for update", [publication.article_id])).rows[0];
      const recorded = await client.query(
        `update site_article_publications set status = 'failed', outcome = 'definite_failure', last_error_code = $2,
                worker_lease_token = null, completed_at = now(), updated_at = now()
          where id = $1 and status = 'publishing' and worker_lease_token = $3`,
        [publicationId, code, leaseToken],
      );
      if (recorded.rowCount !== 1) { await client.query("rollback"); return {ok:false,skipped:"publication_lease_lost"}; }
      if ((articleStatus || synchronize) && current && Number(current.version) === Number(publication.article_version)
        && ["approved", "scheduled", "publishing", "published"].includes(current.status)) {
        if (articleStatus) await client.query("update site_articles set status = $2, status_reason = $3, updated_at = now() where id = $1", [publication.article_id,articleStatus,code]);
        // Another destination may still be inside its provider call. Never reopen
        // editing just because this particular destination could not start.
        await synchronizeArticleDestinations(client, current, articleStatus || "failed");
      }
      await client.query("commit");
      return { ok: false, reason: code };
    } catch(error) { await client.query("rollback").catch(()=>{}); throw error; }
    finally { client.release(); }
  };

  if (!site || site.status !== "active") return fail("site_inactive");
  if (site.verification_state !== "verified") return fail("domain_unverified", { articleStatus: "approved" });
  const eligibleStatuses = publication.action === "publish" ? ["approved", "scheduled", "publishing", "published"] : ["published", "publishing"];
  if (!article || !eligibleStatuses.includes(article.status)) return fail("article_not_approved", { articleStatus: null });
  if (Number(article.version) !== Number(publication.article_version)) return fail("article_version_stale", { articleStatus: null });
  if (publication.action !== "unpublish" && Number(article.approved_version) !== Number(article.version)) return fail("article_not_approved", { articleStatus: null });
  if (!destinationRow || destinationRow.status !== "active") return fail("destination_inactive", { articleStatus: "approved" });

  let destinationRef = null;
  if (publication.action !== "publish") {
    const prior = (await pool.query(
      `select provider_ref, action from site_article_publications
        where article_id = $1 and destination_id = $2 and status = 'published'
        order by completed_at desc nulls last, id desc limit 1`,
      [article.id, publication.destination_id],
    )).rows[0];
    if (!prior?.provider_ref || prior.action === "unpublish") return fail("destination_receipt_missing", { articleStatus: null, synchronize: true });
    destinationRef = prior.provider_ref;
  }

  // This row update serializes with the editor's version/status CAS. Once it wins,
  // edits/rejections cannot change the approved payload during the external write.
  const fenced = await pool.query(
    `${sitePublicationAuthority("$5", "$7")}
     update site_articles set status = 'publishing', updated_at = now()
      where id = $1 and id in (select article_id from authorized) and version = $2 and status = any($3::text[])
        and ($4 = 'unpublish' or approved_version = version)
        and exists (select 1 from site_article_publications p where p.id = $5
          and p.article_id = site_articles.id and p.status = 'publishing' and p.worker_lease_token = $6)
      returning ${SITE_ARTICLE_FIELDS}`,
    [article.id, publication.article_version, eligibleStatuses, publication.action, publicationId, leaseToken,
      JSON.stringify({base_url:destinationRow.base_url,credentials:destinationRow.credentials,
        section_path:destinationRow.section_path,settings:destinationRow.settings,kind:destinationRow.kind})],
  );
  if (!fenced.rows[0]) return fail("article_claim_lost", { articleStatus: null });
  article = fenced.rows[0];
  const adapter = adapters[destinationRow.kind];
  const destination = destinationRuntime(destinationRow, { userId: Number(site.user_id), hostedSlug: site.hosted_slug });
  const payload = articlePayload(article, { publishAt: new Date().toISOString() });
  const result = publication.action === "update"
    ? await adapter.update(destination, destinationRef, payload)
    : publication.action === "unpublish"
      ? await adapter.unpublish(destination, destinationRef)
      : await adapter.publish(destination, payload);

  return finalizeDelivery(pool, { publication, article, site, destinationRow, result, dependencies });
}

async function synchronizeArticleDestinations(client, article, fallbackStatus = "failed") {
  const state = (await client.query(
    `with latest as (
       select distinct on (destination_id) destination_id, action, provider_ref, published_url
         from site_article_publications where article_id = $1 and status = 'published'
         order by destination_id, completed_at desc nulls last, id desc
     )
     select exists (select 1 from site_article_publications where article_id = $1
       and article_version = $2 and status in ('pending','publishing','published_unverified')) as unsettled,
       exists (select 1 from latest where action = 'unpublish') as retired,
       coalesce((select jsonb_agg(to_jsonb(latest) order by destination_id) from latest where action <> 'unpublish'), '[]'::jsonb) as live`,
    [article.id,article.version],
  )).rows[0];
  if (!state) throw new Error("article_delivery_summary_missing");
  const status = state.unsettled ? "publishing" : state.live.length ? "published" : state.retired ? "retired" : fallbackStatus;
  const primary = state.live[0];
  await client.query(
    `update site_articles set status=$2, published_url=$3, provider_ref=$4::jsonb,
       retired_at=case when $2='retired' then coalesce(retired_at,now()) else null end,
       updated_at=now() where id=$1 and version=$5`,
    [article.id,status,primary?.published_url || null,primary?.provider_ref ? JSON.stringify(primary.provider_ref) : null,article.version],
  );
}

async function finalizeDelivery(pool, { publication, article, site, destinationRow, result, dependencies }) {
  const publicationId = Number(publication.id);
  if (result.ok) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select id from site_articles where id=$1 for update",[article.id]);
      const recorded = await client.query(
        `update site_article_publications
            set status = 'published', outcome = 'success', provider_operation_id = $2, provider_ref = $3::jsonb,
                published_url = $4, reconcile_state = 'confirmed', worker_lease_token = null, last_error_code = null,
                completed_at = now(), updated_at = now()
          where id = $1 and ((status = 'publishing' and worker_lease_token = $5)
            or (status = 'published_unverified' and $5::text is null))`,
        [publicationId, result.providerOperationId, result.providerRef ? JSON.stringify(result.providerRef) : null, result.publishedUrl, publication.worker_lease_token || null],
      );
      if (recorded.rowCount !== 1) { await client.query("rollback"); return {ok:false,skipped:"publication_lease_lost"}; }
      if (publication.action === "unpublish") {
        await client.query(`update site_articles set status = 'retired', retired_at = now(), published_url = null, updated_at = now() where id = $1`, [article.id]);
        await recordArticleRevision(client, { article, version: article.version, changeKind: "retired" });
      } else {
        await client.query(
          `update site_articles
              set status = 'published', published_url = coalesce($2, published_url), provider_ref = coalesce($3::jsonb, provider_ref),
                  published_at = coalesce(published_at, now()), status_reason = null, updated_at = now()
            where id = $1`,
          [article.id, result.publishedUrl, result.providerRef ? JSON.stringify(result.providerRef) : null],
        );
        await recordArticleRevision(client, { article, version: article.version, changeKind: "published" });
        // Опубликованный материал становится знанием сайта: следующая проверка дублей его увидит.
        await client.query(
          `insert into knowledge_sources (user_id, site_id, kind, title, raw_text, status)
           select $1, $2, 'site_publication', $3, $4, 'pending'
            where not exists (select 1 from knowledge_sources where site_id = $2 and kind = 'site_publication' and title = $3)`,
          [site.user_id, site.id, `${article.title} — ${result.publishedUrl || article.slug}`.slice(0, 300), `${article.title}\n\n${markdownToText(article.body_markdown)}`.slice(0, 60_000)],
        );
      }
      await synchronizeArticleDestinations(client, article);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return { ok: true, publicationId, outcome: "success", publishedUrl: result.publishedUrl };
  }

  if (result.outcome === "delivery_unknown") {
    const recorded = await pool.query(
      `update site_article_publications
          set status = 'published_unverified', outcome = 'delivery_unknown', provider_operation_id = $2,
              reconcile_state = 'pending', last_error_code = $3, worker_lease_token = null, updated_at = now()
        where id = $1 and status = 'publishing' and worker_lease_token = $4`,
      [publicationId, result.providerOperationId, String(result.reason || "delivery_unknown").slice(0, 80), publication.worker_lease_token || null],
    );
    if (recorded.rowCount !== 1) return {ok:false,skipped:"publication_lease_lost"};
    if (dependencies.queue) await enqueueSiteArticleJob(dependencies.queue, SITE_ARTICLE_JOBS.RECONCILE, { publicationId }, { delayMs: 60_000, jobId: `${siteArticleJobId("reconcile", publicationId)}-${publication.attempts}` });
    return { ok: false, publicationId, outcome: "delivery_unknown" };
  }

  if (result.outcome === "auth_failed") {
    await pool.query(
      `update site_destinations set status = 'needs_reconnect', credential_state = 'invalid', last_error_code = $2, updated_at = now() where id = $1`,
      [destinationRow.id, String(result.reason || "auth_failed").slice(0, 80)],
    );
  }
  const retryable = result.outcome === "rate_limited" || result.retryable === true;
  const recorded = await pool.query(
    `update site_article_publications
        set status = $2, outcome = $3, last_error_code = $4, worker_lease_token = null,
            completed_at = case when $2 = 'failed' then now() else null end, updated_at = now()
      where id = $1 and status = 'publishing' and worker_lease_token = $5`,
    [publicationId, retryable && Number(publication.attempts) < MAX_PUBLISH_ATTEMPTS ? "pending" : "failed", result.outcome, String(result.reason || result.outcome).slice(0, 80), publication.worker_lease_token || null],
  );
  if (recorded.rowCount !== 1) return {ok:false,skipped:"publication_lease_lost"};
  if (retryable && Number(publication.attempts) < MAX_PUBLISH_ATTEMPTS) {
    if (dependencies.queue) await enqueueSiteArticleJob(dependencies.queue, SITE_ARTICLE_JOBS.PUBLISH, { publicationId }, { delayMs: 5 * 60_000, jobId: `${siteArticleJobId("publish", publicationId)}-${publication.attempts}` });
    return { ok: false, publicationId, outcome: result.outcome, retryScheduled: true };
  }
  const summaryClient = await pool.connect();
  try {
    await summaryClient.query("begin");
    await summaryClient.query("select id from site_articles where id=$1 for update", [article.id]);
    await summaryClient.query(
      `update site_articles set status = 'failed', status_reason = $2, updated_at = now() where id = $1 and status = 'publishing'`,
      [article.id, String(result.reason || result.outcome).slice(0, 80)],
    );
    await synchronizeArticleDestinations(summaryClient, article);
    await summaryClient.query("commit");
  } catch(error) { await summaryClient.query("rollback").catch(()=>{}); throw error; }
  finally { summaryClient.release(); }
  return { ok: false, publicationId, outcome: result.outcome };
}

export async function reconcileSitePublication(pool, { publicationId }, dependencies = {}) {
  const adapters = dependencies.adapters || createSiteDestinationAdapters();
  const publication = await loadPublication(pool, publicationId);
  if (!publication || publication.status !== "published_unverified") return { ok: true, skipped: "not_unverified" };
  if (publication.last_error_code === "restored_delivery_unknown") return { ok: false, outcome: "delivery_unknown", reconcile: "restore_review_required" };
  const site = await loadSite(pool, publication.site_id);
  const article = (await pool.query(`select ${SITE_ARTICLE_FIELDS} from site_articles where id = $1`, [publication.article_id])).rows[0];
  const destinationRow = (await pool.query(
    `select id, site_id, kind, base_url, credentials, credential_state, section_path, settings, status from site_destinations where id = $1`,
    [publication.destination_id],
  )).rows[0];
  if (!site || !article || !destinationRow) return { ok: false, reason: "context_missing" };
  const adapter = adapters[destinationRow.kind];
  const destination = destinationRuntime(destinationRow, { userId: Number(site.user_id), hostedSlug: site.hosted_slug });
  if (Number(article.version) !== Number(publication.article_version)) return {ok:false,outcome:"delivery_unknown",reconcile:"article_version_stale"};
  const prior = publication.action === "publish" ? null : (await pool.query(
    `select provider_ref, action from site_article_publications where article_id=$1 and destination_id=$2 and status='published'
      order by completed_at desc nulls last,id desc limit 1`, [article.id,publication.destination_id],
  )).rows[0];
  const result = await adapter.reconcile(destination, publication.provider_operation_id || article.slug, {
    action: publication.action, knownProviderRef: prior?.action === "unpublish" ? null : prior?.provider_ref || null,
    expectedPayload: articlePayload(article),
  });
  if (result.ok) return finalizeDelivery(pool, { publication, article, site, destinationRow, result, dependencies });
  if (destinationRow.kind === "site_hosted" && result.outcome === "definite_failure" && result.reason === "not_found") {
    // Only our hosted adapter owns an authoritative local state. A missing external
    // post (including a WordPress slug lookup) must never authorize a second write.
    await pool.query(
      `update site_article_publications set status = 'pending', outcome = null, reconcile_state = 'confirmed', updated_at = now()
        where id = $1 and attempts < $2`,
      [publicationId, MAX_PUBLISH_ATTEMPTS],
    );
    if (dependencies.queue) await enqueueSiteArticleJob(dependencies.queue, SITE_ARTICLE_JOBS.PUBLISH, { publicationId }, { jobId: `${siteArticleJobId("publish", publicationId)}-r${publication.attempts}` });
    return { ok: false, publicationId, outcome: "not_found", retryScheduled: true };
  }
  await pool.query(
    `update site_article_publications set reconcile_state = 'unresolved', last_error_code = $2, updated_at = now() where id = $1`,
    [publicationId, String(result.reason || result.outcome).slice(0, 80)],
  );
  return { ok: false, publicationId, outcome: result.outcome, reconcile: "unresolved" };
}

export function createSiteArticlesWorker({ connection, pool, queue, concurrency = 1, dependencies = {} }) {
  const deps = { ...dependencies, queue };
  const worker = new Worker(
    SITE_ARTICLES_QUEUE,
    async (job) => {
      switch (job.name) {
        case SITE_ARTICLE_JOBS.PLAN: return planSiteArticles(pool, job.data, deps);
        case SITE_ARTICLE_JOBS.GENERATE: return generateSiteArticle(pool, job.data, deps);
        case SITE_ARTICLE_JOBS.PUBLISH: return publishSiteArticle(pool, job.data, deps);
        case SITE_ARTICLE_JOBS.RECONCILE: return reconcileSitePublication(pool, job.data, deps);
        case SITE_ARTICLE_JOBS.PROBE: return (deps.runProbe || runSiteVisibilityProbe)(pool, { siteId: Number(job.data.siteId), requestedByUserId: job.data.requestedByUserId ?? null }, deps);
        case SITE_ARTICLE_JOBS.REPORT: return (deps.runReport || runSiteReportOnDemand)(pool, { siteId: Number(job.data.siteId), requestedByUserId: job.data.requestedByUserId ?? null, siteArticlesQueue: queue }, deps);
        case SITE_ARTICLE_JOBS.REFINE: {
          const refined = await (deps.refineProfile || refineSiteProfile)(pool, { profileId: Number(job.data.profileId), force: Boolean(job.data.force) }, deps);
          // После уточнения профиля интерпретируем отчёты, ждущие модель.
          const pending = await pool.query(
            `select id from site_reports where profile_id = $1 and status = 'ready' and interpretation_status = 'pending' order by id`,
            [Number(job.data.profileId)],
          );
          for (const row of pending.rows) await enqueueSiteArticleJob(queue, SITE_ARTICLE_JOBS.INTERPRET, { reportId: Number(row.id) });
          return { ...refined, interpretationsQueued: pending.rows.length };
        }
        case SITE_ARTICLE_JOBS.INTERPRET: return (deps.interpretReport || interpretSiteReport)(pool, { reportId: Number(job.data.reportId), force: Boolean(job.data.force) }, deps);
        default: return { ok: true, skipped: "unknown_job" };
      }
    },
    { connection, concurrency },
  );
  worker.on("ready", () => console.log("[site-articles] очередь материалов для сайтов слушается"));
  worker.on("failed", (job, error) => console.error("[site-articles] job failed", {
    name: job?.name, data: job?.data, code: error?.code || error?.name || "worker_failed",
  }));
  worker.on("error", (error) => console.error("[site-articles] queue error", { errorName: error?.name || "Error" }));
  return worker;
}
