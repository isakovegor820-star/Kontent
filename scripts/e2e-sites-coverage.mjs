import { finalizeE2eBrowserLifecycle } from "./e2e-browser-lifecycle.mjs";
import { createE2eBrowserContext } from "./e2e-browser-context.mjs";
import assert from "node:assert/strict";

export const FAKE_WORDPRESS_HOST = "wordpress.aurora.test";
export const FAKE_SITES_ARTICLE_TITLE = "R02 Sites fixture";
export const fakeSitesState = {
  token: "synthetic-site-proof", posts: new Map(), writes: [], publicReads: [],
  ai: { interview: 0, classifier: 0, interpretation: 0, article: 0, embedding: 0 },
};

const ARTICLE_BODY = [
  "Эта страница помогает последовательно подготовить описание сайта. Сначала стоит определить назначение материала и читателя, затем выбрать понятную структуру. Каждый раздел отвечает на отдельный вопрос и содержит только проверяемые сведения.",
  "## Как организовать описание",
  "Начните с короткого пояснения темы. Далее перечислите доступные разделы и объясните, какую информацию читатель найдёт внутри. Заголовки должны описывать содержание, а ссылки вести к соответствующим страницам. Сложные термины лучше раскрыть при первом упоминании.",
  "## Что проверить перед публикацией",
  "Прочитайте текст целиком и проверьте последовательность мысли. Удалите повторы, неподтверждённые обещания и сведения, для которых нет источника. Убедитесь, что названия разделов совпадают с содержанием. После редакторской проверки сохраните материал и отдельно подтвердите его публикацию.",
].join("\n\n");

/** Separate fake provider branch: real Sites prompts/validators, no general AI counters. */
export function handleFakeSitesAiRequest(req, res, raw) {
  if (req.method !== "POST" || !["/v1/chat/completions", "/v1/embeddings", "/api/embed"].includes(req.url)) return false;
  let body;
  try { body = JSON.parse(raw); } catch { return false; }
  if (req.url === "/v1/embeddings" || req.url === "/api/embed") {
    if (!new RegExp(`^${FAKE_SITES_ARTICLE_TITLE}\\s`, "u").test(String(body.input || ""))) return false;
    fakeSitesState.ai.embedding += 1;
    res.setHeader("content-type", "application/json");
    const embedding = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0);
    res.end(JSON.stringify(req.url === "/api/embed"
      ? { embeddings: [embedding] }
      : { data: [{ embedding }], usage: { prompt_tokens: 100, total_tokens: 100 } }));
    return true;
  }
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const system = String(messages.find((message) => message?.role === "system")?.content || "");
  const user = String(messages.findLast((message) => message?.role === "user")?.content || "");
  let kind;
  let completion;
  if (system.startsWith("Ты — доказательный OSINT-аналитик продукта «Аврора».")) {
    let payload;
    try { payload = JSON.parse(user); } catch { return false; }
    if (payload?.scope?.confirmedDomain !== FAKE_WORDPRESS_HOST) return false;
    assert.equal(payload.promptVersion, "site-osint-interview-v1");
    assert(Array.isArray(payload.questions) && payload.questions.length > 0);
    kind = "interview";
    completion = {
      batchId: payload.outputContract.batchId, reportStatus: "complete",
      answers: payload.questions.map((question) => ({
        questionId: question.id, status: "insufficient_data",
        shortAnswer: "Недостаточно данных в синтетическом срезе.",
        explanation: "Локальный fixture проверяет передачу и сохранение результата; внешний анализ не выполнялся.",
        facts: [], evidenceIds: [], confidence: "none", contradictions: [],
        gaps: ["Для содержательного вывода нужен разрешённый источник."], requiredIntegrations: [], recommendationHooks: [],
      })),
    };
  } else if (system.startsWith("Ты — классификатор страниц сайта.") && user.startsWith(`SITE: ${FAKE_WORDPRESS_HOST}\n`)) {
    kind = "classifier";
    completion = {
      pages: [...user.matchAll(/^- url: (\S+) \|.* \| current: ([a-z_]+)$/gmu)].map((match) => ({ url: match[1], type: match[2] })),
      topicClusters: [],
    };
  } else if (system.startsWith("Ты — аналитик Авроры.") && user.includes(`Сайт: ${FAKE_WORDPRESS_HOST};`)) {
    kind = "interpretation";
    completion = {
      summary: "Отчёт описывает доступные страницы локального синтетического сайта. Его структура позволяет проверить сохранение результатов анализа и редакторскую проверку материалов.",
      whatItMeans: ["Выводы ограничены страницами, перечисленными в отчёте."],
      startWith: [], watchOut: ["Посещаемость и коммерческие результаты этим анализом не измерялись."],
    };
  } else if (system.startsWith("Ты — редактор сайта компании.") && user.startsWith(`SITE: ${FAKE_WORDPRESS_HOST}\n`)) {
    assert(system.includes("Машиночитаемая страница о компании"), "Sites fixture received an unexpected article type");
    kind = "article";
    completion = {
      title: FAKE_SITES_ARTICLE_TITLE,
      metaDescription: "Последовательная подготовка описания сайта: структура материала, понятные заголовки, проверка источников и редакторское подтверждение публикации.",
      bodyMarkdown: ARTICLE_BODY, internalLinks: [], faq: null,
      organization: { "@type": "Organization", name: FAKE_WORDPRESS_HOST, url: `https://${FAKE_WORDPRESS_HOST}/` },
    };
  } else return false;
  assert.notEqual(body.stream, true, "Sites worker completion unexpectedly became streaming");
  fakeSitesState.ai[kind] += 1;
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    id: `sites-fixture-${kind}-${fakeSitesState.ai[kind]}`, model: body.model,
    choices: [{ message: { role: "assistant", content: JSON.stringify(completion) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
  }));
  return true;
}

/** Installed only by the disposable E2E harness, never imported by application code. */
export function sitesNetworkShim(fakeBase) {
  return `
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
const fixtureHost = ${JSON.stringify(FAKE_WORDPRESS_HOST)};
const fixtureSink = new URL(${JSON.stringify(fakeBase)});
const originalLookup = dns.lookup.bind(dns);
const originalTxt = dns.resolveTxt.bind(dns);
const originalHttpsRequest = https.request.bind(https);
dns.lookup = (hostname, options) => hostname === fixtureHost
  ? Promise.resolve([{ address: '93.184.216.34', family: 4 }]) : originalLookup(hostname, options);
dns.resolveTxt = (hostname, ...args) => hostname.includes(fixtureHost) ? Promise.resolve([]) : originalTxt(hostname, ...args);
https.request = (options, callback) => options?.headers?.host === fixtureHost
  ? http.request({ ...options, protocol: 'http:', hostname: fixtureSink.hostname, port: fixtureSink.port, servername: undefined }, callback)
  : originalHttpsRequest(options, callback);
syncBuiltinESMExports();
`;
}

export function handleFakeSitesRequest(req, res, raw) {
  if (req.headers.host !== FAKE_WORDPRESS_HOST) return false;
  const url = new URL(req.url, `https://${FAKE_WORDPRESS_HOST}`);
  if (req.method === "GET" && !url.pathname.startsWith("/wp-json/")) {
    fakeSitesState.publicReads.push(url.pathname);
    if (url.pathname === "/robots.txt") {
      res.setHeader("content-type", "text/plain");
      res.end(`User-agent: *\nAllow: /\nSitemap: https://${FAKE_WORDPRESS_HOST}/sitemap.xml`);
    } else if (url.pathname === "/sitemap.xml") {
      res.setHeader("content-type", "application/xml");
      res.end(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://${FAKE_WORDPRESS_HOST}/</loc></url><url><loc>https://${FAKE_WORDPRESS_HOST}/services</loc></url></urlset>`);
    } else if (url.pathname === "/" || url.pathname === "/services") {
      const home = url.pathname === "/";
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(`<html lang="ru"><head><title>${home ? "Локальный редакционный сайт" : "Структура редакторской проверки"}</title><meta name="description" content="Синтетические страницы для проверки анализа и подготовки материалов."><meta name="aurora-site-verification" content="${fakeSitesState.token}"></head><body><main><h1>${home ? "Локальный редакционный сайт" : "Редакторская проверка"}</h1><p>${home ? "Этот синтетический сайт используется только внутри изолированной проверки. Он содержит описание редакторской работы и позволяет проверить создание профиля." : "Редакторская проверка включает чтение черновика, сверку текста с источниками и подтверждение готовой версии. Материалы сохраняют до отдельного одобрения публикации."}</p><a href="${home ? "/services" : "/"}">${home ? "Редакторская проверка" : "Главная"}</a></main></body></html>`);
    } else {
      res.statusCode = 404;
      res.end("fixture public path not found");
    }
    return true;
  }
  assert.equal(req.headers.authorization, "Basic " + Buffer.from("fixture:fixture-app-password").toString("base64"), "WordPress used the wrong account");
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/wp-json/wp/v2/users/me") {
    res.end(JSON.stringify({ id: 42, name: "Fixture WordPress editor", capabilities: { publish_posts: true } }));
    return true;
  }
  if (url.pathname.startsWith("/wp-json/wp/v2/posts")) {
    if (req.method === "GET") {
      res.end(JSON.stringify([...fakeSitesState.posts.values()].filter((post) => post.slug === url.searchParams.get("slug"))));
      return true;
    }
    const input = JSON.parse(raw);
    const existingId = Number(url.pathname.split("/").at(-1));
    const id = Number.isSafeInteger(existingId) && existingId > 0 ? existingId : fakeSitesState.posts.size + 800;
    const post = { ...fakeSitesState.posts.get(id), ...input, id, link: `https://${FAKE_WORDPRESS_HOST}/${input.slug || fakeSitesState.posts.get(id)?.slug}` };
    fakeSitesState.posts.set(id, post);
    fakeSitesState.writes.push({ id, status: input.status, title: input.title, content: input.content });
    res.statusCode = existingId ? 200 : 201;
    res.end(JSON.stringify(post));
    return true;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ code: "fixture_not_found" }));
  return true;
}

/** Measure the actual editing controls, which have a different minimum width from the read-only tabs. */
export async function assertSitesEditorActionsReflow(page, { widths = [320, 390, 640] } = {}) {
  const originalViewport = page.viewportSize();
  assert(originalViewport, "Sites editor reflow requires a restorable viewport");
  const evidence = [];
  let failure;
  try {
    for (const width of widths) {
      await page.setViewportSize({ ...originalViewport, width });
      const save = page.getByRole("button", { name: "Сохранить как новую версию", exact: true });
      // Let viewport reflow and scroll anchoring settle before centering the measured row.
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await save.evaluate((button) => button.parentElement.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" }));
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const geometry = await save.evaluate((button) => {
        const card = button.closest(".card-plain");
        const controls = [button, ...button.parentElement.querySelectorAll("button")].filter((item, index, items) => items.indexOf(item) === index);
        return {
          stage: "article editing actions", viewport: innerWidth,
          document: document.documentElement.scrollWidth, body: document.body.scrollWidth,
          cardRight: card.getBoundingClientRect().right, columnRight: card.parentElement.getBoundingClientRect().right,
          controls: controls.map((control) => {
            const rect = control.getBoundingClientRect();
            const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
            const textRects = [];
            while (walker.nextNode()) {
              if (!walker.currentNode.textContent.trim()) continue;
              const range = document.createRange(); range.selectNodeContents(walker.currentNode);
              textRects.push(...Array.from(range.getClientRects(), (item) => ({ left: item.left, right: item.right, top: item.top, bottom: item.bottom })));
            }
            return {
              label: control.textContent.trim(), left: rect.left, right: rect.right, height: rect.height,
              whiteSpace: getComputedStyle(control.querySelector("span") || control).whiteSpace,
              textRects, textInside: textRects.length > 0 && textRects.every((item) => item.left >= rect.left && item.right <= rect.right && item.top >= rect.top && item.bottom <= rect.bottom),
              hit: control.contains(document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2)),
            };
          }),
        };
      });
      evidence.push(geometry);
      assert.deepEqual(geometry.controls.map((control) => control.label), ["Сохранить как новую версию", "Отмена"]);
      assert(geometry.document <= geometry.viewport && geometry.body <= geometry.viewport
        && geometry.cardRight <= geometry.columnRight + 0.5
        && geometry.controls.every((control) => control.left >= 0 && control.right <= geometry.viewport
          && control.height >= 44 && control.textInside && control.hit),
      `Sites editor actions are clipped or unreachable: ${JSON.stringify(geometry)}`);
    }
  } catch (error) { failure = error; }
  try { await page.setViewportSize(originalViewport); }
  catch (error) { failure = failure ? new AggregateError([failure, error], "Sites reflow and viewport restore failed") : error; }
  if (failure) throw failure;
  return evidence;
}

export async function runSitesCoverage({ page, pool, userId, projectId, waitFor, artifactDir, captureScreenshot, readMutationReceipt,
  navigate = (url, options) => page.goto(url, options), reload = () => page.reload() }) {
  const reflow = [];
  const assertReflow = async (stage) => {
    const geometry = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    reflow.push({ stage, ...geometry });
    assert(geometry.document <= geometry.viewport && geometry.body <= geometry.viewport, `Sites ${stage} overflows: ${JSON.stringify(geometry)}`);
  };
  const publicReads = [];
  const readHosted = async (publicUrl) => {
    const url = new URL(publicUrl);
    assert(url.hostname.endsWith(".sites.aurora.test"), "Unexpected hosted fixture domain");
    // The request reaches the real TLS ingress/Host rewrite and public Next route.
    // A fresh anonymous context never borrows the author's authenticated cookies.
    const { context: reader, transport } = await createE2eBrowserContext(page.context().browser(), { baseUrl: new URL(page.url()).origin, ignoreHTTPSErrors: true });
    let failure; let evidence;
    try {
      const response = await reader.request.get(new URL(url.pathname, page.url()).href, {
        headers: { host: url.host, accept: "text/html,application/xml,text/plain" },
        maxRedirects: 0,
      });
      const text = await response.text();
      evidence = { url: url.href, status: response.status(), anonymous: true };
      publicReads.push(evidence);
      return { status: response.status(), text };
    } catch (error) { failure = error; throw error; }
    finally {
      await finalizeE2eBrowserLifecycle({ context: reader, transport, error: failure,
        writeEvidence: ({ error, transportAttempts }) => {
          evidence ??= { url: url.href, anonymous: true };
          Object.assign(evidence, { transportAttempts, ...(error ? { error: error.message } : {}) });
          if (!publicReads.includes(evidence)) publicReads.push(evidence);
        } });
    }
  };
  const siteUrl = `https://${FAKE_WORDPRESS_HOST}/`;
  const sitePosts = [];
  const observeCreate = (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/sites") sitePosts.push(request);
  };
  const responseTo = (method, pathname) => page.waitForResponse((response) => response.request().method() === method && new URL(response.url()).pathname === pathname);
  const assertProjectRequest = (response) => assert.equal(response.request().headers()["x-aurora-project-id"], String(projectId), "Sites UI wrote outside the selected project");
  assert.equal(Number((await pool.query("select count(*) as n from sites where project_id=$1 and confirmed_domain=$2", [projectId, FAKE_WORDPRESS_HOST])).rows[0].n), 0, "Sites creation must start without a seeded site");
  await navigate("/app/sites");
  await page.locator("#site-url").fill(siteUrl);
  page.on("request", observeCreate);
  let created;
  try {
    await page.getByRole("button", { name: "Подключить и запустить аудит", exact: true }).click();
    await page.getByText("Подтверди, что у тебя есть право анализировать этот сайт.", { exact: true }).waitFor({ state: "visible" });
    assert.equal(sitePosts.length, 0, "Sites submitted without domain-analysis consent");
    const consent = page.getByRole("checkbox", { name: "У меня есть право анализировать этот сайт и публиковать на нём материалы", exact: true });
    await consent.click();
    assert.equal(await consent.getAttribute("aria-checked"), "true");
    const [response] = await Promise.all([
      responseTo("POST", "/api/sites"),
      page.getByRole("button", { name: "Подключить и запустить аудит", exact: true }).click(),
    ]);
    assert.equal(response.status(), 201, "Sites UI did not create a new site");
    assertProjectRequest(response);
    assert.match(response.request().headers()["idempotency-key"], /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu);
    assert.deepEqual(response.request().postDataJSON(), { url: siteUrl, consent: true });
    created = await readMutationReceipt(response);
    assert.equal(created.ok, true);
    assert.equal(created.created, true);
    assert.equal(created.analysisError, null, "Sites was saved but the analysis did not start");
    assert.equal(sitePosts.length, 1, "Sites creation submitted more than once");
  } finally {
    page.off("request", observeCreate);
  }
  const siteId = Number(created.site.id);
  const analysisId = Number(created.latestAnalysis.id);
  assert.equal(created.site.projectId, Number(projectId));
  assert.equal(created.site.canonicalUrl, siteUrl);
  assert.equal(created.site.verification.state, "unverified");
  assert(Number.isSafeInteger(siteId) && siteId > 0 && Number.isSafeInteger(analysisId) && analysisId > 0);
  // The fake public document receives the challenge returned by the real creation API.
  fakeSitesState.token = created.site.verification.token;
  assert.equal(typeof fakeSitesState.token, "string");
  assert(fakeSitesState.token.length > 10);
  const analysis = await waitFor(async () => {
    const row = (await pool.query(`select j.status,j.error_code,j.question_count,j.project_id,j.user_id,j.site_id,
        jsonb_array_length(j.result->'osint'->'answers') as answer_count,
        p.id as profile_id,p.page_count,p.ai_classification->>'status' as classifier_status,
        r.interpretation_status
      from site_analysis_jobs j
      join sites s on s.id=j.site_id and s.project_id=j.project_id
      left join site_profiles p on p.id=s.latest_profile_id and p.analysis_job_id=j.id
      left join site_reports r on r.profile_id=p.id and r.kind='initial_audit'
      where j.id=$1`, [analysisId])).rows[0];
    if (row?.status === "failed") throw new Error(`Sites analysis failed: ${row.error_code}`);
    return row?.status === "ready" && row.classifier_status === "ready" && row.interpretation_status === "ready" ? row : null;
  }, "Sites full crawler/interview/profile/report did not become ready", 120_000);
  assert.equal(Number(analysis.site_id), siteId);
  assert.equal(Number(analysis.project_id), Number(projectId));
  assert.equal(Number(analysis.user_id), Number(userId));
  assert.equal(Number(analysis.question_count), 51);
  assert.equal(Number(analysis.answer_count), 51);
  assert.equal(Number(analysis.page_count), 2);
  assert(fakeSitesState.publicReads.includes("/robots.txt") && fakeSitesState.publicReads.includes("/sitemap.xml") && fakeSitesState.publicReads.includes("/services"));
  assert.equal(fakeSitesState.ai.interview, 26);
  assert.equal(fakeSitesState.ai.classifier, 1);
  assert.equal(fakeSitesState.ai.interpretation, 1);
  await reload();
  await page.getByRole("tab", { name: "Материалы", exact: true }).click();
  await assertReflow("loaded materials");
  await page.locator("#manual-type").selectOption("machine_readable_page");
  const brief = "R02: подготовить описание структуры страницы сайта и редакторской проверки";
  await page.locator("#manual-brief").fill(brief);
  const [articleResponse] = await Promise.all([
    responseTo("POST", `/api/sites/${siteId}/articles`),
    page.locator("#manual-brief").locator("xpath=ancestor::form").getByRole("button", { name: "Создать", exact: true }).click(),
  ]);
  assert.equal(articleResponse.status(), 202);
  assertProjectRequest(articleResponse);
  assert.deepEqual(articleResponse.request().postDataJSON(), { articleType: "machine_readable_page", brief });
  const articleCreated = await readMutationReceipt(articleResponse);
  assert.equal(articleCreated.ok, true);
  assert.equal(articleCreated.article.status, "draft");
  const articleId = Number(articleCreated.article.id);
  const generated = await waitFor(async () => {
    const row = (await pool.query("select * from site_articles where id=$1 and site_id=$2 and project_id=$3", [articleId, siteId, projectId])).rows[0];
    if (["failed", "rejected"].includes(row?.status)) throw new Error(`Sites article failed: ${row.status_reason}`);
    return row?.status === "needs_review" ? row : null;
  }, "Sites manually requested article did not reach human review", 60_000);
  assert.equal(Number(generated.user_id), Number(userId));
  assert.equal(generated.article_type, "machine_readable_page");
  assert.equal(generated.origin, "manual");
  assert.equal(generated.source_ref.brief, brief);
  assert.equal(generated.generation.promptVersion, "site-article-v1");
  assert.deepEqual(generated.quality.issues, []);
  assert.equal(generated.title, FAKE_SITES_ARTICLE_TITLE);
  assert.equal(fakeSitesState.ai.article, 1);
  assert.equal(await page.locator("#manual-brief").inputValue(), "");
  assert.equal(Number((await pool.query("select count(*) as n from site_article_publications where article_id=$1", [articleId])).rows[0].n), 0, "Sites generation published before review");
  await page.getByRole("button", { name: new RegExp(FAKE_SITES_ARTICLE_TITLE, "u") }).click();
  await page.getByRole("heading", { name: FAKE_SITES_ARTICLE_TITLE, exact: true }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Править", exact: true }).click();
  const reviewedBody = `${generated.body_markdown}\n\nРедакторская проверка этой версии завершена. Публикация выполняется только после отдельного подтверждения.`;
  await page.locator("#edit-body").fill(reviewedBody);
  reflow.push(...await assertSitesEditorActionsReflow(page));
  const [editResponse] = await Promise.all([
    responseTo("PATCH", `/api/sites/${siteId}/articles/${articleId}`),
    page.getByRole("button", { name: "Сохранить как новую версию", exact: true }).click(),
  ]);
  assert.equal(editResponse.status(), 200);
  assertProjectRequest(editResponse);
  const reviewed = (await pool.query("select version,body_html,body_markdown,status from site_articles where id=$1", [articleId])).rows[0];
  assert.equal(Number(reviewed.version), Number(generated.version) + 1);
  assert.equal(reviewed.status, "needs_review");
  assert.equal(reviewed.body_markdown, reviewedBody);
  await reload();
  await page.getByRole("button", { name: "Проверить", exact: true }).click();
  await waitFor(async () => (await pool.query("select verification_state from sites where id=$1", [siteId])).rows[0].verification_state === "verified", "Sites domain ownership did not verify via the fake document head");
  await page.getByRole("tab", { name: "Публикация", exact: true }).click();
  await page.getByRole("button", { name: "Включить раздел", exact: true }).click();
  await waitFor(async () => Number((await pool.query("select count(*) as n from site_destinations where site_id=$1 and kind='site_hosted' and status='active'", [siteId])).rows[0].n) === 1, "hosted destination did not persist");
  const hostedSlug = (await pool.query("select hosted_slug from sites where id=$1", [siteId])).rows[0].hosted_slug;
  assert.match(hostedSlug, /^[a-z0-9][a-z0-9-]+[a-z0-9]$/u);
  assert.match(generated.slug, /^[a-z0-9][a-z0-9-]*[a-z0-9]$/u);
  const hostedOrigin = `https://${hostedSlug}.sites.aurora.test`;
  const beforePublication = await readHosted(`${hostedOrigin}/${generated.slug}`);
  assert.equal(beforePublication.status, 404, "Unapproved Sites article was exposed publicly");
  assert(!beforePublication.text.includes(reviewed.body_html), "Unapproved body leaked in the public response");
  await page.locator("#wp-url").fill(`https://${FAKE_WORDPRESS_HOST}`);
  await page.locator("#wp-user").fill("fixture");
  await page.locator("#wp-pass").fill("fixture-app-password");
  await page.getByRole("button", { name: "Подключить и проверить", exact: true }).click();
  await waitFor(async () => Number((await pool.query("select count(*) as n from site_destinations where site_id=$1 and kind='wordpress' and credential_state='ready'", [siteId])).rows[0].n) === 1, "WordPress account did not verify and save");
  assert.equal(await page.locator("#wp-pass").inputValue(), "", "WordPress credential remained in the form");
  const stored = (await pool.query("select credentials from site_destinations where site_id=$1 and kind='wordpress'", [siteId])).rows[0].credentials;
  assert(stored && !stored.includes("fixture-app-password"), "WordPress credential was not encrypted");
  await page.getByRole("tab", { name: "Материалы", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(FAKE_SITES_ARTICLE_TITLE, "u") }).click();
  await page.getByRole("heading", { name: FAKE_SITES_ARTICLE_TITLE, exact: true }).waitFor({ state: "visible" });
  await page.locator("pre").filter({ hasText: "Редакторская проверка этой версии завершена." }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Одобрить", exact: true }).click();
  await waitFor(async () => Number((await pool.query("select count(*) as n from site_article_publications where article_id=$1 and action='publish' and status='published'", [articleId])).rows[0].n) === 2, "both Sites destinations must publish the reviewed revision", 60_000);
  assert.equal(fakeSitesState.writes.length, 1, "WordPress published more than once");
  assert.equal(fakeSitesState.writes[0].content, reviewed.body_html, "WordPress published a different reviewed body");
  const publishedVersions = (await pool.query("select article_version from site_article_publications where article_id=$1 and action='publish'", [articleId])).rows;
  assert(publishedVersions.every((row) => Number(row.article_version) === Number(reviewed.version)), "Sites publish used an obsolete article version");
  const hostedReceipt = (await pool.query(`select p.provider_ref->>'url' as url from site_article_publications p
    join site_destinations d on d.id=p.destination_id and d.kind='site_hosted'
    where p.article_id=$1 and p.action='publish' and p.status='published'`, [articleId])).rows[0];
  assert.equal(new URL(hostedReceipt.url).origin, hostedOrigin);
  assert.equal(new URL(hostedReceipt.url).pathname, `/${generated.slug}`, "Pre-publication denial checked a different article URL");
  const publicArticle = await readHosted(hostedReceipt.url);
  assert.equal(publicArticle.status, 200, "Confirmed hosted publication is not publicly readable");
  assert(publicArticle.text.includes(reviewed.body_html), "Public route did not serve the exact approved content");
  assert(publicArticle.text.includes(`href="${hostedReceipt.url}"`), "Public article canonical is missing");
  const publicIndex = await readHosted(`${hostedOrigin}/`);
  assert.equal(publicIndex.status, 200);
  assert(publicIndex.text.includes(`href="${hostedReceipt.url}"`), "Hosted index did not expose the confirmed article");
  const sitemap = await readHosted(`${hostedOrigin}/sitemap.xml`);
  assert.equal(sitemap.status, 200);
  assert(sitemap.text.includes(`<loc>${hostedReceipt.url}</loc>`), "Hosted sitemap omitted the confirmed article");
  const robots = await readHosted(`${hostedOrigin}/robots.txt`);
  assert.equal(robots.status, 200);
  assert(robots.text.includes(`Sitemap: ${hostedOrigin}/sitemap.xml`));
  await reload();
  await page.getByRole("tab", { name: "Материалы", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(FAKE_SITES_ARTICLE_TITLE, "u") }).click();
  await page.getByRole("button", { name: "Снять с публикации", exact: true }).click();
  await waitFor(async () => Number((await pool.query("select count(*) as n from site_article_publications where article_id=$1 and action='unpublish' and status='published'", [articleId])).rows[0].n) === 2, "both Sites destinations must unpublish using their own receipts", 60_000);
  assert.equal(fakeSitesState.writes.length, 2);
  assert.equal(fakeSitesState.writes[1].id, fakeSitesState.writes[0].id, "unpublish used a different WordPress destination receipt");
  assert.equal(fakeSitesState.writes[1].status, "draft");
  const removedArticle = await readHosted(hostedReceipt.url);
  assert.equal(removedArticle.status, 404, "Confirmed hosted unpublish still exposes the article");
  assert(!removedArticle.text.includes(reviewed.body_html), "Retired body leaked in the public response");
  const retiredSitemap = await readHosted(`${hostedOrigin}/sitemap.xml`);
  assert.equal(retiredSitemap.status, 200);
  assert(!retiredSitemap.text.includes(`<loc>${hostedReceipt.url}</loc>`), "Hosted sitemap retained an unpublished article");
  const retiredIndex = await readHosted(`${hostedOrigin}/`);
  assert.equal(retiredIndex.status, 200);
  assert(!retiredIndex.text.includes(`href="${hostedReceipt.url}"`), "Hosted index retained an unpublished article");
  const retiredCard = page.getByRole("button", { name: new RegExp(FAKE_SITES_ARTICLE_TITLE, "u") });
  await retiredCard.getByText("Снят", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  await page.getByRole("heading", { name: FAKE_SITES_ARTICLE_TITLE, exact: true }).locator("..").getByText("Снят", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await page.getByText("Публикуется", { exact: true }).count(), 0, "Sites UI retained an in-flight state after unpublish completed");
  await assertReflow("unpublished article");
  await captureScreenshot(page, { path: `${artifactDir}/interface-sites.png`, fullPage: true });
  return { siteId, analysisId, articleId, createdThroughUi: true, consentRequired: true, analysisQuestions: 51, crawledPages: 2,
    profileAndInterpretationReady: true, manualArticleThroughUi: true, generatedAwaitingReview: true, editedVersionReloaded: Number(reviewed.version),
    domainVerifiedThroughUi: true, encryptedCredentials: true, destinations: 2, wordpressWrites: 2, exactApprovedContent: true,
    unpublishOwnReceipt: true, terminalUnpublishedUi: true, anonymousHostedHttp: publicReads, reflow, sitesAiCalls: { ...fakeSitesState.ai } };
}
