import { readFile } from "node:fs/promises";
import pg, { type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../scripts/migrate.mjs";
import { approveSiteArticle, editSiteArticle, findSiteArticle } from "@/lib/sites/articles-service";
import { type SiteRow } from "@/lib/sites/service";
import { createArticlePublications } from "@/lib/site-articles/service.mjs";
import { generateSiteArticle, publishSiteArticle, reconcileSitePublication } from "../../worker/site-articles-worker.mjs";
import { listHostedArticles, loadHostedArticle, type HostedSite } from "@/lib/site-hosted/service";
import { recoverSiteArticleGeneration } from "../../worker/site-scheduler.mjs";
import { encryptDestinationCredentials } from "@/lib/site-destinations/index.mjs";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL || "";
const target = new URL(databaseUrl);
if (!(["127.0.0.1", "localhost"].includes(target.hostname)) || target.pathname !== "/aurora_publication_gate_test") throw new Error("Site publication test requires disposable local aurora_publication_gate_test");
const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 12 });
let userId: number;
let projectId: number;
let site: SiteRow;
let articleId: number;
let hostedId: number;
let wordpressId: number;
let sequence = 0;

async function transaction<T>(task: (db: PoolClient) => Promise<T>) {
  const db = await pool.connect();
  try { await db.query("begin"); const result = await task(db); await db.query("commit"); return result; }
  catch (error) { await db.query("rollback"); throw error; }
  finally { db.release(); }
}
async function article() { return (await findSiteArticle(pool, Number(site.id), articleId))!; }
function adapter(kind: string) {
  const ref = kind === "wordpress" ? { id: 77, slug: "article", status: "publish" } : { slug: "article" };
  return { publish: vi.fn(async () => ({ ok: true, outcome: "success", providerOperationId: "article", providerRef: ref, publishedUrl: `https://${kind}.example.test/article` })),
    update: vi.fn(async () => ({ ok: true, outcome: "success", providerOperationId: "article", providerRef: ref, publishedUrl: `https://${kind}.example.test/article` })),
    unpublish: vi.fn(async () => ({ ok: true, outcome: "success", providerOperationId: "article", providerRef: { ...ref, status: "draft" }, publishedUrl: null })),
    reconcile: vi.fn(), retryPolicy: "reconcile_before_retry" };
}
async function operation(destinationId: number, action: "publish" | "update" | "unpublish" = "publish") {
  const rows = await createArticlePublications(pool, { article: await article(), destinations: [{ id: destinationId }], action });
  return Number(rows[0].id);
}

beforeAll(async () => {
  vi.stubEnv("TOKENS_MASTER_KEY", "isolated-site-publication-test-key");
  await pool.query("drop schema public cascade"); await pool.query("create schema public");
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { ...process.env, DATABASE_URL: databaseUrl }, logger: { log() {} } });
  userId = Number((await pool.query("insert into users (email) values ('site-review@example.test') returning id")).rows[0].id);
  projectId = Number((await pool.query("insert into projects (name, created_by_user_id) values ('Site review', $1) returning id", [userId])).rows[0].id);
});
afterAll(async () => { vi.unstubAllEnvs(); await pool.end(); });
beforeEach(async () => {
  sequence += 1;
  site = (await pool.query<SiteRow>("insert into sites (project_id, user_id, confirmed_domain, canonical_url, verification_token, verification_state, hosted_slug) values ($1, $2, $3, $4, 'isolated-test-token', 'verified', $5) returning *", [projectId, userId, `site${sequence}.example.test`, `https://site${sequence}.example.test`, `site${sequence}`])).rows[0];
  const destinations = (await pool.query("insert into site_destinations (site_id, kind, base_url, credential_state, credentials) values ($1, 'site_hosted', 'https://hosted.example.test', 'not_required', null), ($1, 'wordpress', 'https://wordpress.example.test', 'ready', $2) returning id", [site.id, encryptDestinationCredentials({ username: 'review', appPassword: 'test-app-password' }, { userId })])).rows;
  hostedId = Number(destinations[0].id); wordpressId = Number(destinations[1].id);
  articleId = Number((await pool.query("insert into site_articles (site_id, project_id, user_id, article_type, origin, slug, title, body_markdown, body_html, status, version, approved_version, approved_by) values ($1, $2, $3, 'company_news', 'manual', 'article', 'Original article', 'Original content', '<p>Original content</p>', 'needs_review', 1, null, null) returning id", [site.id, projectId, userId])).rows[0].id);
});

describe("site article review and publication lifecycle", () => {
  it("rejects approval of a stale snapshot instead of approving unseen edits", async () => {
    const stale = await article();
    await pool.query("update site_articles set version = 2, title = 'Unseen changes' where id = $1", [articleId]);
    await expect(transaction(db => approveSiteArticle(db, { site, article: stale, userId }))).rejects.toMatchObject({ code: "article_version_conflict" });
    expect((await article()).approved_version).toBeNull();
    expect((await pool.query("select id from site_article_publications where article_id = $1", [articleId])).rowCount).toBe(0);
  });

  it("counts 12 concurrent retries of one approval only once", async () => {
    const snapshot = await article();
    await Promise.all(Array.from({ length: 12 }, () => transaction(db => approveSiteArticle(db, { site, article: snapshot, userId }))));
    expect(Number((await pool.query("select approved_streak from sites where id = $1", [site.id])).rows[0].approved_streak)).toBe(1);
    expect((await pool.query("select id from site_article_publications where article_id = $1", [articleId])).rowCount).toBe(2);
  });

  it("does not overwrite edits that arrived after the editor loaded its snapshot", async () => {
    const stale = await article();
    await pool.query("update site_articles set version = 2, title = 'Other editor text' where id = $1", [articleId]);
    await expect(transaction(db => editSiteArticle(db, { site, article: stale, userId, title: 'Stale save', linkablePages: [] }))).rejects.toMatchObject({ code: "article_version_conflict" });
    expect((await article()).title).toBe("Other editor text");
  });

  it("delivers to each destination once even when the first finishes earlier", async () => {
    await pool.query("update site_articles set status = 'approved', approved_version = version, approved_at = now(), approved_by = $2 where id = $1", [articleId, userId]);
    const registry = { site_hosted: adapter("site_hosted"), wordpress: adapter("wordpress") };
    const first = await operation(hostedId); const second = await operation(wordpressId);
    expect(await publishSiteArticle(pool, { publicationId: first }, { adapters: registry })).toMatchObject({ ok: true });
    expect(await publishSiteArticle(pool, { publicationId: second }, { adapters: registry })).toMatchObject({ ok: true });
    await publishSiteArticle(pool, { publicationId: second }, { adapters: registry });
    expect(registry.site_hosted.publish).toHaveBeenCalledOnce(); expect(registry.wordpress.publish).toHaveBeenCalledOnce();
  });

  it("unpublishes using the destination's own provider ref", async () => {
    await pool.query("update site_articles set status = 'published', approved_version = version, approved_at = now(), approved_by = $2, provider_ref = '{\"slug\":\"hosted-ref\"}' where id = $1", [articleId, userId]);
    const published = await operation(wordpressId);
    await pool.query("update site_article_publications set status = 'published', outcome = 'success', provider_ref = '{\"id\":77,\"slug\":\"article\",\"status\":\"publish\"}' where id = $1", [published]);
    const unpublish = await operation(wordpressId, "unpublish");
    const registry = { wordpress: adapter("wordpress") };
    expect(await publishSiteArticle(pool, { publicationId: unpublish }, { adapters: registry })).toMatchObject({ ok: true });
    expect(registry.wordpress.unpublish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 77 }));
    expect(registry.wordpress.publish).not.toHaveBeenCalled();
    expect((await article()).status).toBe("retired");
  });

  it("refuses a stale publication version without calling the provider", async () => {
    const publicationId = await operation(hostedId);
    await pool.query("update site_articles set status = 'approved', version = 2, approved_version = 2, approved_by = user_id, approved_at = now() where id = $1", [articleId]);
    const registry = { site_hosted: adapter("site_hosted") };
    expect(await publishSiteArticle(pool, { publicationId }, { adapters: registry })).toMatchObject({ ok: false, reason: "article_version_stale" });
    expect(registry.site_hosted.publish).not.toHaveBeenCalled();
  });

  it("does not report an uncertain unpublish as success while WordPress still returns a public post", async () => {
    await pool.query("update site_articles set status = 'publishing', approved_version = version, approved_at = now(), approved_by = user_id where id = $1", [articleId]);
    const publicationId = await operation(wordpressId, "unpublish");
    await pool.query("update site_article_publications set status = 'published_unverified', provider_operation_id = 'article' where id = $1", [publicationId]);
    const registry = { wordpress: adapter("wordpress") };
    registry.wordpress.reconcile.mockResolvedValue({ ok: true, outcome: "success", providerRef: { id: 77, status: "publish" }, publishedUrl: "https://wordpress.example.test/article" });
    expect(await reconcileSitePublication(pool, { publicationId }, { adapters: registry })).toMatchObject({ ok: false });
    expect((await article()).status).not.toBe("retired");
  });

  it("does not resend an unknown WordPress POST on slug absence alone", async () => {
    await pool.query("update site_articles set status = 'publishing', approved_version = version, approved_at = now(), approved_by = user_id where id = $1", [articleId]);
    const publicationId = await operation(wordpressId);
    await pool.query("update site_article_publications set status = 'published_unverified', attempts = 1 where id = $1", [publicationId]);
    const registry = { wordpress: adapter("wordpress") }; const queue = { add: vi.fn() };
    registry.wordpress.reconcile.mockResolvedValue({ ok: false, outcome: "definite_failure", reason: "not_found" });
    await reconcileSitePublication(pool, { publicationId }, { adapters: registry, queue });
    expect(queue.add).not.toHaveBeenCalled();
    expect((await pool.query("select status from site_article_publications where id = $1", [publicationId])).rows[0].status).toBe("published_unverified");
  });
});


describe("site generation failure boundaries", () => {
  async function draft() { await pool.query("update site_articles set status = 'draft' where id = $1", [articleId]); }
  const dependencies = () => ({ embed: null, engine: "navy-deepseek", completeAiText: vi.fn(async () => ({ text: '{"title":"Too short","bodyMarkdown":"Short","metaDescription":"Short","internalLinks":[]}', engine: "navy-deepseek" })) });

  it("restores a retryable state when reservation acquisition fails", async () => {
    await draft();
    await expect(generateSiteArticle(pool, { articleId }, { ...dependencies(), acquireUsage: async () => { throw new Error("database unavailable"); } })).rejects.toThrow();
    expect((await article()).status).toBe("failed");
  });

  it("leaves a draft retryable while another reservation owns generation", async () => {
    await draft(); const deps = dependencies();
    await expect(generateSiteArticle(pool, { articleId }, { ...deps, acquireUsage: async () => ({ state: "in_progress" }) })).rejects.toMatchObject({ code: "generation_in_progress" });
    expect((await article()).status).toBe("draft"); expect(deps.completeAiText).not.toHaveBeenCalled();
  });

  it("does not run paid generation again for a committed version", async () => {
    await draft(); const deps = dependencies();
    await generateSiteArticle(pool, { articleId }, { ...deps, acquireUsage: async () => ({ state: "committed", reservationId: 1 }) });
    expect(deps.completeAiText).not.toHaveBeenCalled(); expect((await article()).status).not.toBe("generating");
  });

  it("rolls back generation output if committing its quota reservation fails", async () => {
    await draft();
    await expect(generateSiteArticle(pool, { articleId }, { ...dependencies(), commitUsage: async () => false })).rejects.toMatchObject({ code: "ai_usage_reservation_lost" });
    expect((await article()).quality).toBeNull();
    expect((await article()).status).toBe("failed");
  });
});


it("recovers lost draft jobs and exposes interrupted generation without another AI call", async () => {
  await pool.query("update site_articles set status = 'draft', updated_at = now() - interval '20 minutes' where id = $1", [articleId]);
  const queue = { add: vi.fn(async (..._args: unknown[]) => ({})) };
  await recoverSiteArticleGeneration(pool, { siteArticlesQueue: queue });
  expect(queue.add).toHaveBeenCalledWith("generate", { articleId }, expect.objectContaining({ jobId: expect.stringContaining(`site-articles-generate-${articleId}-v1-`) }));
  queue.add.mockClear();
  await pool.query("update site_articles set status = 'generating', updated_at = now() - interval '31 minutes' where id = $1", [articleId]);
  await recoverSiteArticleGeneration(pool, { siteArticlesQueue: queue });
  expect((await article()).status).toBe("failed");
  expect(queue.add.mock.calls.some(call => (call[1] as { articleId: number }).articleId === articleId)).toBe(false);
});


it("keeps generated content, quota and publication intents committed when Redis is unavailable", async () => {
  await pool.query("update site_articles set status = 'draft', article_type = 'audience_answer' where id = $1", [articleId]);
  await pool.query("insert into site_profiles (site_id, linkable_pages) values ($1, $2::jsonb)", [site.id, JSON.stringify([{ url: `https://${site.confirmed_domain}/guide` }])]);
  await pool.query("update sites set latest_profile_id = (select id from site_profiles where site_id = $1 order by id desc limit 1) where id = $1", [site.id]);
  await pool.query("update sites set publishing_mode = 'auto', approved_streak = auto_unlock_streak where id = $1", [site.id]);
  const completion = JSON.stringify({
    title: "Как подготовить материалы для сайта?",
    metaDescription: "Разбираем порядок подготовки полезных материалов для сайта компании: проверка фактов, структура, редактирование и согласование.",
    bodyMarkdown: `Подготовка материалов начинается с проверки фактов и вопросов читателей. Подробнее — в [руководстве](https://${site.confirmed_domain}/guide).\n\n## Подготовка\n\n${Array.from({ length: 320 }, (_, i) => `слово${i}`).join(" ")}\n\n## Коротко\n\n- Проверьте факты\n- Согласуйте текст`,
    internalLinks: [], faq: [], organization: null,
  });
  const result = await generateSiteArticle(pool, { articleId }, { embed: null, engine: "navy-deepseek", completeAiText: async () => ({ text: completion, engine: "navy-deepseek" }), queue: { add: async () => { throw new Error("Redis unavailable"); } } });
  expect(result).toMatchObject({ ok: true, status: "approved", publications: 2 });
  expect((await article()).title).toBe("Как подготовить материалы для сайта?");
  expect((await pool.query("select status from ai_usage where reservation_key = $1", [`worker:site-article:${articleId}:v1`])).rows[0].status).toBe("committed");
  expect((await pool.query("select status from site_article_publications where article_id = $1", [articleId])).rows.map(row => row.status)).toEqual(["pending", "pending"]);
});


it("does not expose a WordPress-only success through the hosted destination", async () => {
  await pool.query("update site_articles set status = 'published', approved_version = version, approved_at = now(), approved_by = user_id where id = $1", [articleId]);
  const wp = await operation(wordpressId);
  await pool.query("update site_article_publications set status = 'published', outcome = 'success' where id = $1", [wp]);
  const hosted: HostedSite = { id: Number(site.id), slug: String(site.hosted_slug), confirmedDomain: site.confirmed_domain, canonicalUrl: site.canonical_url, brandName: "Review", origin: "https://hosted.example.test" };
  expect(await loadHostedArticle(pool, hosted, "article")).toBeNull();
  expect(await listHostedArticles(pool, hosted)).toEqual([]);
});

it("keeps an article public until every successful destination has been unpublished", async () => {
  await pool.query("update site_articles set status = 'approved', approved_version = version, approved_at = now(), approved_by = user_id where id = $1", [articleId]);
  const registry = { site_hosted: adapter("site_hosted"), wordpress: adapter("wordpress") };
  await publishSiteArticle(pool, { publicationId: await operation(hostedId) }, { adapters: registry });
  await publishSiteArticle(pool, { publicationId: await operation(wordpressId) }, { adapters: registry });
  await publishSiteArticle(pool, { publicationId: await operation(wordpressId, "unpublish") }, { adapters: registry });
  expect((await article()).status).toBe("published");
  expect((await article()).published_url).toBe("https://site_hosted.example.test/article");
  await publishSiteArticle(pool, { publicationId: await operation(hostedId, "unpublish") }, { adapters: registry });
  expect((await article()).status).toBe("retired");
});


it("does not repeat interrupted AI work when BullMQ redelivers the old job", async () => {
  await pool.query("update site_articles set status = 'failed', status_reason = 'generation_interrupted' where id = $1", [articleId]);
  const completeAiText = vi.fn();
  expect(await generateSiteArticle(pool, { articleId }, { completeAiText, embed: null })).toMatchObject({ skipped: "not_generatable" });
  expect(completeAiText).not.toHaveBeenCalled();
  expect((await article()).status_reason).toBe("generation_interrupted");
});

it.each(["delivery_unknown", "rate_limited"])("does not overwrite confirmed success with a late %s from an expired worker", async (outcome) => {
  await pool.query("update site_articles set status = 'approved', approved_version = version, approved_at = now(), approved_by = user_id where id = $1", [articleId]);
  const publicationId = await operation(hostedId);
  let started!: () => void;
  const sending = new Promise<void>(resolve => { started = resolve; });
  let finish!: (value: unknown) => void;
  const provider = new Promise(resolve => { finish = resolve; });
  const registry = { site_hosted: { ...adapter("site_hosted"), publish: async () => { started(); return provider; } } };
  const job = publishSiteArticle(pool, { publicationId }, { adapters: registry });
  await sending;
  // Equivalent to recovery after a paused worker's lease has expired.
  await pool.query("update site_article_publications set status = 'published_unverified', worker_lease_token = null where id = $1", [publicationId]);
  registry.site_hosted.reconcile.mockResolvedValue({ ok: true, outcome: "success", providerRef: { slug: "article" }, providerOperationId: "article", publishedUrl: "https://site_hosted.example.test/article" });
  await reconcileSitePublication(pool, { publicationId }, { adapters: registry });
  finish({ ok: false, outcome, providerOperationId: "article", reason: "late_response" });
  await job;
  expect((await pool.query("select status, outcome, reconcile_state from site_article_publications where id = $1", [publicationId])).rows[0])
    .toMatchObject({ status: "published", outcome: "success", reconcile_state: "confirmed" });
});
