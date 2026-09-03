import { describe, expect, it, vi } from "vitest";

import { generateSiteArticle, publishSiteArticle, reconcileSitePublication } from "./site-articles-worker.mjs";

const filler = Array.from({ length: 320 }, (_, index) => `слово${index}`).join(" ");
const goodCompletion = JSON.stringify({
  title: "Сколько стоит имплантация зубов?",
  metaDescription: "Разбираем, из чего складывается цена имплантации и на что смотреть при выборе клиники в 2026 году.",
  bodyMarkdown: `Имплантация стоит от 40 до 90 тысяч рублей за зуб. Подробнее — на [странице услуги](https://clinic.example/uslugi/implantaciya).\n\n## Из чего складывается цена\n\n${filler}\n\n## Коротко\n\n- пункт\n- пункт`,
  internalLinks: [],
  faq: [{ question: "Сколько стоит?", answer: "От 40 тысяч." }],
  organization: null,
});

function siteRow(overrides = {}) {
  return {
    id: 5, project_id: 3, user_id: 9, confirmed_domain: "clinic.example", canonical_url: "https://clinic.example/",
    verification_state: "verified", status: "active", publishing_mode: "confirm", auto_unlock_streak: 10, approved_streak: 0,
    cadence: {}, hosted_slug: "clinic", brand_name: "Улыбка", latest_profile_id: 77, latest_analysis_id: 41,
    topics: [{ key: "имплантация", label: "имплантация", pageCount: 3, coverage: "strong" }],
    gaps: [], linkable_pages: [{ url: "https://clinic.example/uslugi/implantaciya", title: "Имплантация", pageType: "service" }],
    technical: {}, summary: "s", ...overrides,
  };
}

function articleRow(overrides = {}) {
  return {
    id: 100, site_id: 5, project_id: 3, user_id: 9, article_type: "audience_answer", origin: "audience_question",
    source_key: "question:1", source_ref: { kind: "audience_question", id: 1, question: "Сколько стоит имплантация?" },
    title: "", slug: "draft-x", meta_description: null, body_markdown: "", body_html: null, internal_links: [],
    structured_data: null, evidence_keys: [], similarity_check: null, quality: null, generation: null, version: 1,
    status: "generating", status_reason: null, approved_by: null, approved_version: null, approved_at: null,
    published_url: null, provider_ref: null, scheduled_at: null, published_at: null, retired_at: null,
    created_at: new Date(), updated_at: new Date(), ...overrides,
  };
}

function makePool({ site = siteRow(), article = articleRow(), corpusPages = [], onQuery = null } = {}) {
  const calls = [];
  const handler = async (sql, params) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    const custom = onQuery?.(text, params);
    if (custom) return custom;
    if (text.includes("update site_articles set status = 'generating'")) return { rows: [article] };
    if (text.includes("from sites s") && text.includes("left join site_profiles")) return { rows: [site] };
    if (text.includes("from knowledge_chunks c")) return { rows: [{ text: "Клиника работает с 2010 года" }] };
    if (text.includes("from site_analysis_pages")) return { rows: corpusPages };
    if (text.includes("from site_articles\n      where site_id = $1 and status = 'published'")) return { rows: [] };
    if (text.includes("select id from site_articles where site_id = $1 and slug = $2")) return { rows: [] };
    if (text.startsWith("update site_articles\n            set title")) return { rows: [{ ...article, ...JSON.parse(JSON.stringify({})), id: article.id, version: article.version, title: params[1], slug: params[2], status: params[11] }] };
    return { rows: [] };
  };
  const client = { query: vi.fn(handler), release: vi.fn() };
  const pool = { query: vi.fn(handler), connect: vi.fn(async () => client) };
  return { pool, client, calls };
}

const usageDeps = () => ({
  acquireUsage: vi.fn(async () => ({ state: "acquired", reservationId: 501 })),
  commitUsage: vi.fn(async () => ({ status: "committed" })),
  releaseUsage: vi.fn(async () => true),
  embed: null,
});

describe("generateSiteArticle", () => {
  it("reserves AI usage, validates the completion, stores the article for review and commits", async () => {
    const { pool, client, calls } = makePool();
    const completeAiText = vi.fn(async () => ({ text: goodCompletion, engine: "navy-deepseek", fallbackUsed: false, attempts: 1 }));
    const deps = { ...usageDeps(), completeAiText, engine: "navy-deepseek" };
    const result = await generateSiteArticle(pool, { articleId: 100 }, deps);
    expect(result).toMatchObject({ ok: true, articleId: 100, status: "needs_review", similarity: "ok", autoPublished: false });
    expect(deps.acquireUsage).toHaveBeenCalledWith(pool, expect.objectContaining({ userId: 9, kind: "site_article", key: expect.stringContaining("site-article") }));
    expect(completeAiText).toHaveBeenCalledTimes(1);
    const [request] = completeAiText.mock.calls[0];
    expect(request.system).toContain("ALLOWED_LINKS");
    expect(request.user).toContain("- https://clinic.example/uslugi/implantaciya");
    expect(request.user).toContain("FACTS:\n- Клиника работает с 2010 года");
    const update = calls.find((call) => call.sql.startsWith("update site_articles\n            set title"));
    expect(update.params[1]).toBe("Сколько стоит имплантация зубов?");
    expect(update.params[2]).toBe("skolko-stoit-implantatsiya-zubov");
    expect(update.params[11]).toBe("needs_review");
    expect(JSON.parse(update.params[7])["@type"]).toBe("FAQPage");
    expect(client.query).toHaveBeenCalledWith("commit");
    expect(deps.commitUsage).toHaveBeenCalledWith(pool, 9, 501);
    expect(calls.some((call) => call.sql.includes("insert into site_article_revisions"))).toBe(true);
  });

  it("retries once with feedback and fails the article on persistent quality errors without publishing", async () => {
    const { pool, calls } = makePool();
    const bad = JSON.stringify({ title: "Коротко", metaDescription: "d", bodyMarkdown: "Слишком коротко.", internalLinks: [] });
    const completeAiText = vi.fn(async () => ({ text: bad, engine: "e", fallbackUsed: false, attempts: 1 }));
    const deps = { ...usageDeps(), completeAiText, engine: "navy-deepseek" };
    const result = await generateSiteArticle(pool, { articleId: 100 }, deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("quality");
    expect(completeAiText).toHaveBeenCalledTimes(2);
    expect(completeAiText.mock.calls[1][0].user).toContain("ПРЕДЫДУЩАЯ ПОПЫТКА ОТКЛОНЕНА");
    const failed = calls.find((call) => call.sql.includes("status_reason = 'quality'"));
    expect(failed).toBeDefined();
    expect(JSON.parse(failed.params[1]).issues.some((issue) => issue.code === "too_short")).toBe(true);
    expect(deps.commitUsage).toHaveBeenCalled();
  });

  it("rejects a semantic duplicate of an existing page instead of sending it to review", async () => {
    const duplicateText = "Имплантация стоит от 40 до 90 тысяч рублей за зуб. Подробнее на странице услуги. Из чего складывается цена " + filler;
    const { pool, calls } = makePool({ corpusPages: [{ url: "https://clinic.example/ceny", title: "Цены", main_content: duplicateText }] });
    const completeAiText = vi.fn(async () => ({ text: goodCompletion, engine: "e", fallbackUsed: false, attempts: 1 }));
    const result = await generateSiteArticle(pool, { articleId: 100 }, { ...usageDeps(), completeAiText, engine: "navy-deepseek" });
    expect(result).toMatchObject({ ok: true, similarity: "reject", status: "rejected" });
    const update = calls.find((call) => call.sql.startsWith("update site_articles\n            set title"));
    expect(update.params[11]).toBe("rejected");
    expect(update.params[12]).toBe("semantic_duplicate");
    expect(JSON.parse(update.params[8]).nearestUrl).toBe("https://clinic.example/ceny");
  });

  it("auto-approves and enqueues publication only when the site is in unlocked auto mode", async () => {
    const site = siteRow({ publishing_mode: "auto", approved_streak: 10 });
    const { pool, calls } = makePool({
      site,
      onQuery: (sql) => (sql.includes("from site_destinations") && sql.includes("status = 'active'")
        ? { rows: [{ id: 7, kind: "site_hosted" }] }
        : sql.includes("insert into site_article_publications") ? { rows: [{ id: 900, status: "pending" }] } : null),
    });
    const queue = { add: vi.fn(async () => ({})) };
    const result = await generateSiteArticle(pool, { articleId: 100 }, { ...usageDeps(), completeAiText: vi.fn(async () => ({ text: goodCompletion, engine: "e" })), engine: "navy-deepseek", queue });
    expect(result).toMatchObject({ ok: true, autoPublished: true, publications: 1, status: "approved" });
    expect(calls.some((call) => call.sql.includes("set status = 'approved'"))).toBe(true);
    expect(queue.add).toHaveBeenCalledWith("publish", { publicationId: 900 }, expect.objectContaining({ jobId: "site-articles-publish-900" }));
  });

  it("releases the reservation and marks the article failed when the provider throws", async () => {
    const { pool, calls } = makePool();
    const deps = { ...usageDeps(), completeAiText: vi.fn(async () => { throw Object.assign(new Error("boom"), { code: "provider_error" }); }), engine: "navy-deepseek" };
    await expect(generateSiteArticle(pool, { articleId: 100 }, deps)).rejects.toMatchObject({ code: "provider_error" });
    expect(deps.releaseUsage).toHaveBeenCalledWith(pool, 9, 501);
    expect(deps.commitUsage).not.toHaveBeenCalled();
    expect(calls.some((call) => call.sql.includes("set status = 'failed', status_reason = $2") && call.params[1] === "provider_error")).toBe(true);
  });

  it("stops on the daily AI limit and leaves the article as a draft for the next run", async () => {
    const { pool, calls } = makePool();
    const deps = { ...usageDeps(), acquireUsage: vi.fn(async () => ({ state: "limit" })), completeAiText: vi.fn() };
    await expect(generateSiteArticle(pool, { articleId: 100 }, deps)).rejects.toMatchObject({ code: "ai_usage_limit", retryable: true });
    expect(deps.completeAiText).not.toHaveBeenCalled();
    expect(calls.some((call) => call.sql.includes("status_reason = 'ai_usage_limit'"))).toBe(true);
  });
});

function publicationPool({ site = siteRow(), article, publication, destination, onQuery = null }) {
  const calls = [];
  const handler = async (sql, params) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    const custom = onQuery?.(text, params);
    if (custom) return custom;
    if (text.includes("set status = 'publishing', attempts = attempts + 1")) return { rows: [{ id: publication.id }] };
    if (text.includes("from site_article_publications p join site_articles a")) return { rows: [publication] };
    if (text.includes("from sites s") && text.includes("left join site_profiles")) return { rows: [site] };
    if (text.includes("from site_articles where id = $1")) return { rows: [article] };
    if (text.includes("from site_destinations where id = $1")) return { rows: [destination] };
    return { rows: [] };
  };
  const client = { query: vi.fn(handler), release: vi.fn() };
  const pool = { query: vi.fn(handler), connect: vi.fn(async () => client) };
  return { pool, client, calls };
}

const approvedArticle = () => articleRow({ status: "approved", title: "Сколько стоит", slug: "skolko-stoit", body_markdown: "## Раз\n\nтекст", body_html: "<h2>Раз</h2><p>текст</p>", version: 2, approved_version: 2, approved_by: 9, approved_at: new Date() });
const pendingPublication = (overrides = {}) => ({ id: 900, article_id: 100, destination_id: 7, article_version: 2, action: "publish", status: "pending", attempts: 0, site_id: 5, user_id: 9, provider_operation_id: null, ...overrides });
const hostedDestination = { id: 7, site_id: 5, kind: "site_hosted", base_url: "https://clinic.sites.aurora.test", credentials: null, credential_state: "not_required", section_path: null, settings: { hostedSlug: "clinic" }, status: "active" };

describe("publishSiteArticle", () => {
  const adapters = (publishResult) => ({
    site_hosted: { publish: vi.fn(async () => publishResult), reconcile: vi.fn(), update: vi.fn(), unpublish: vi.fn(), verify: vi.fn() },
    wordpress: { publish: vi.fn(), reconcile: vi.fn(), update: vi.fn(), unpublish: vi.fn(), verify: vi.fn() },
  });

  it("publishes an approved version, records the url and indexes the article into the site knowledge base", async () => {
    const { pool, client, calls } = publicationPool({ article: approvedArticle(), publication: pendingPublication(), destination: hostedDestination });
    const registry = adapters({ ok: true, outcome: "success", providerOperationId: "skolko-stoit", providerRef: { slug: "skolko-stoit" }, publishedUrl: "https://clinic.sites.aurora.test/skolko-stoit" });
    const result = await publishSiteArticle(pool, { publicationId: 900 }, { adapters: registry });
    expect(result).toMatchObject({ ok: true, outcome: "success", publishedUrl: "https://clinic.sites.aurora.test/skolko-stoit" });
    expect(registry.site_hosted.publish).toHaveBeenCalledWith(expect.objectContaining({ kind: "site_hosted", settings: expect.objectContaining({ hostedSlug: "clinic" }) }), expect.objectContaining({ slug: "skolko-stoit", bodyHtml: "<h2>Раз</h2><p>текст</p>" }));
    expect(calls.some((call) => call.sql.includes("set status = 'published', outcome = 'success'"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("set status = 'published', published_url"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("insert into knowledge_sources") && call.params[2].startsWith("Сколько стоит"))).toBe(true);
    expect(client.query).toHaveBeenCalledWith("commit");
  });

  it("refuses to publish for an unverified domain or a stale article version", async () => {
    const unverified = publicationPool({ site: siteRow({ verification_state: "unverified" }), article: approvedArticle(), publication: pendingPublication(), destination: hostedDestination });
    const registry = adapters({ ok: true });
    expect(await publishSiteArticle(unverified.pool, { publicationId: 900 }, { adapters: registry })).toMatchObject({ ok: false, reason: "domain_unverified" });
    expect(registry.site_hosted.publish).not.toHaveBeenCalled();
    const stale = publicationPool({ article: approvedArticle(), publication: pendingPublication({ article_version: 1 }), destination: hostedDestination });
    expect(await publishSiteArticle(stale.pool, { publicationId: 900 }, { adapters: registry })).toMatchObject({ ok: false, reason: "article_version_stale" });
  });

  it("keeps an unknown delivery unverified and schedules reconcile instead of a second publish", async () => {
    const { pool, calls } = publicationPool({ article: approvedArticle(), publication: pendingPublication(), destination: hostedDestination });
    const queue = { add: vi.fn(async () => ({})) };
    const registry = adapters({ ok: false, outcome: "delivery_unknown", deliveryUnknown: true, retryable: false, providerOperationId: "skolko-stoit", reason: "network_error" });
    const result = await publishSiteArticle(pool, { publicationId: 900 }, { adapters: registry, queue });
    expect(result).toMatchObject({ ok: false, outcome: "delivery_unknown" });
    expect(calls.some((call) => call.sql.includes("status = 'published_unverified'"))).toBe(true);
    expect(queue.add).toHaveBeenCalledWith("reconcile", { publicationId: 900 }, expect.objectContaining({ delay: 60_000 }));
    expect(queue.add).not.toHaveBeenCalledWith("publish", expect.anything(), expect.anything());
  });

  it("marks the destination for reconnect on auth failure and fails the publication", async () => {
    const { pool, calls } = publicationPool({ article: approvedArticle(), publication: pendingPublication(), destination: { ...hostedDestination, kind: "wordpress" } });
    const registry = adapters({});
    registry.wordpress.publish = vi.fn(async () => ({ ok: false, outcome: "auth_failed", retryable: false, providerOperationId: "skolko-stoit", reason: "rest_not_logged_in" }));
    const result = await publishSiteArticle(pool, { publicationId: 900 }, { adapters: registry });
    expect(result).toMatchObject({ ok: false, outcome: "auth_failed" });
    expect(calls.some((call) => call.sql.includes("set status = 'needs_reconnect', credential_state = 'invalid'"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("update site_articles set status = 'failed'"))).toBe(true);
  });
});

describe("reconcileSitePublication", () => {
  it("re-queues a publish only when the provider confirms the article is absent", async () => {
    const { pool, calls } = publicationPool({ article: approvedArticle(), publication: pendingPublication({ status: "published_unverified", provider_operation_id: "skolko-stoit", attempts: 1 }), destination: hostedDestination });
    const queue = { add: vi.fn(async () => ({})) };
    const registry = { site_hosted: { reconcile: vi.fn(async () => ({ ok: false, outcome: "definite_failure", reason: "not_found", providerOperationId: "skolko-stoit" })) } };
    const result = await reconcileSitePublication(pool, { publicationId: 900 }, { adapters: registry, queue });
    expect(result).toMatchObject({ ok: false, outcome: "not_found", retryScheduled: true });
    expect(calls.some((call) => call.sql.includes("set status = 'pending', outcome = null, reconcile_state = 'confirmed'"))).toBe(true);
    expect(queue.add).toHaveBeenCalledWith("publish", { publicationId: 900 }, expect.anything());
  });

  it("finalizes a found article as published", async () => {
    const { pool, calls } = publicationPool({ article: approvedArticle(), publication: pendingPublication({ status: "published_unverified", provider_operation_id: "skolko-stoit", attempts: 1 }), destination: hostedDestination });
    const registry = { site_hosted: { reconcile: vi.fn(async () => ({ ok: true, outcome: "success", providerOperationId: "skolko-stoit", providerRef: { slug: "skolko-stoit" }, publishedUrl: "https://clinic.sites.aurora.test/skolko-stoit" })) } };
    const result = await reconcileSitePublication(pool, { publicationId: 900 }, { adapters: registry });
    expect(result).toMatchObject({ ok: true, outcome: "success" });
    expect(calls.some((call) => call.sql.includes("set status = 'published', outcome = 'success'"))).toBe(true);
  });
});
