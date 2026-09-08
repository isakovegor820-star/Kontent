import { describe, expect, it, vi } from "vitest";
import * as fixture from "./e2e-sites-coverage.mjs";
import { crawlSite } from "../src/lib/site-crawler.mjs";
import { buildSiteEvidenceSnapshot } from "../src/lib/site-analysis/evidence.mjs";
import { aggregateSiteInterviewReport, buildSiteInterviewPrompt, createSiteInterviewBatches, parseAndValidateSiteInterviewBatch } from "../src/lib/site-analysis/interview.mjs";
import { SITE_INTERVIEW_QUESTIONS } from "../src/lib/site-analysis/questions.data.mjs";
import { buildSiteProfile, classifySitePages } from "../src/lib/site-profile/profile.mjs";
import { buildClassifierPrompt, buildInterpretationPrompt, parseClassifierResponse, validateInterpretation } from "../src/lib/site-ai/interpretation.mjs";
import { buildInitialAuditReport } from "../src/lib/site-report/initial-audit.mjs";
import { buildArticlePrompt, parseArticleGeneration, validateArticle } from "../src/lib/site-articles/generation.mjs";
import { EMBED_DIM } from "../worker/embeddings.mjs";

function responseSink() {
  return { statusCode: 200, headers: {}, body: "", setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = String(value); } };
}

async function crawlFixture() {
  return crawlSite({ targetUrl: `https://${fixture.FAKE_WORDPRESS_HOST}/`, confirmedDomain: fixture.FAKE_WORDPRESS_HOST, consent: true }, {
    fetchText: async (url) => {
      const parsed = new URL(url);
      expect(parsed.hostname).toBe(fixture.FAKE_WORDPRESS_HOST);
      const res = responseSink();
      expect(fixture.handleFakeSitesRequest({ headers: { host: parsed.hostname }, method: "GET", url: parsed.pathname }, res, "")).toBe(true);
      return { url: parsed.href, status: res.statusCode, ok: res.statusCode < 400, headers: new Headers(res.headers), text: async () => res.body, byteLength: Buffer.byteLength(res.body) };
    },
  });
}

function complete(prompt) {
  const res = responseSink();
  const body = { model: "gpt-4o-mini", messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }] };
  expect(fixture.handleFakeSitesAiRequest({ url: "/v1/chat/completions", method: "POST" }, res, JSON.stringify(body))).toBe(true);
  return JSON.parse(res.body).choices[0].message.content;
}

describe("Sites E2E fake boundary with production contracts", () => {
  it("awaits the owned navigation boundary before the first Sites mutation", async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const afterNavigation = new Error("first UI step reached");
    const fill = vi.fn(async () => { throw afterNavigation; });
    const page = { goto: vi.fn(), locator: vi.fn(() => ({ fill })) };
    const navigate = vi.fn(() => pending);
    const result = fixture.runSitesCoverage({ page, pool: { query: async () => ({ rows: [{ n: 0 }] }) },
      projectId: 10, navigate }).catch(error => error);
    await Promise.resolve();
    expect(navigate).toHaveBeenCalledWith("/app/sites");
    expect(page.goto).not.toHaveBeenCalled();
    expect(fill).not.toHaveBeenCalled();
    release();
    expect(await result).toBe(afterNavigation);
    expect(fill).toHaveBeenCalledOnce();
  });

  it("retains a failed navigation boundary without beginning Sites UI work", async () => {
    const failure = new Error("captured GET failed before navigation");
    const page = { goto: vi.fn(), locator: vi.fn() };
    await expect(fixture.runSitesCoverage({ page, pool: { query: async () => ({ rows: [{ n: 0 }] }) },
      projectId: 10, navigate: async () => { throw failure; } })).rejects.toBe(failure);
    expect(page.goto).not.toHaveBeenCalled();
    expect(page.locator).not.toHaveBeenCalled();
  });

  it("serves public robots/sitemap/pages through the real bounded crawler without WordPress credentials", async () => {
    const crawled = await crawlFixture();
    expect(crawled.pages.map((page) => new URL(page.url).pathname).sort()).toEqual(["/", "/services"]);
    expect(buildSiteProfile({ confirmedDomain: fixture.FAKE_WORDPRESS_HOST, pages: crawled.pages }).pageCount).toBe(2);
  });

  it("satisfies all 51 real interview schemas with explicit synthetic insufficient-data answers", async () => {
    const crawled = await crawlFixture();
    const snapshot = buildSiteEvidenceSnapshot({ confirmedDomain: fixture.FAKE_WORDPRESS_HOST, pages: crawled.pages, checkedAt: "2026-09-05T12:00:00Z" });
    const completed = createSiteInterviewBatches(SITE_INTERVIEW_QUESTIONS, 2).map((batch) => {
      const prompt = buildSiteInterviewPrompt({ batchId: batch.id, questions: batch.questions, snapshot });
      const parsed = parseAndValidateSiteInterviewBatch(complete(prompt), { batchId: batch.id, questions: batch.questions, evidenceIds: prompt.evidenceIds, entityIds: prompt.entityIds });
      expect(parsed.ok, JSON.stringify(parsed.errors)).toBe(true);
      return parsed.value;
    });
    const report = aggregateSiteInterviewReport({ snapshot, batches: completed });
    expect(report.reportStatus).toBe("complete");
    expect(report.answers).toHaveLength(51);
    expect(report.answers.every((answer) => answer.status === "insufficient_data" && answer.facts.length === 0)).toBe(true);
  });

  it("passes the real classifier and report interpretation validators", async () => {
    const crawled = await crawlFixture();
    const site = { confirmedDomain: fixture.FAKE_WORDPRESS_HOST, canonicalUrl: `https://${fixture.FAKE_WORDPRESS_HOST}/` };
    const profile = buildSiteProfile({ ...site, pages: crawled.pages, report: crawled.report });
    const classification = parseClassifierResponse(complete(buildClassifierPrompt({ pages: classifySitePages(crawled.pages), topics: profile.topics, confirmedDomain: site.confirmedDomain })), { knownUrls: crawled.pages.map((page) => page.url), knownTopicKeys: profile.topics.map((topic) => topic.key) });
    expect(Object.keys(classification.pageTypes)).toHaveLength(2);
    const report = buildInitialAuditReport({ site, profile, analysis: {} });
    const validated = validateInterpretation(complete(buildInterpretationPrompt({ payload: report.payload })), { payload: report.payload });
    expect(validated.ok).toBe(true);
    expect(validated.issues).toEqual([]);
  });

  it("generates a real publishable machine-readable article without invented company facts", () => {
    const site = { confirmedDomain: fixture.FAKE_WORDPRESS_HOST, canonicalUrl: `https://${fixture.FAKE_WORDPRESS_HOST}/` };
    const prompt = buildArticlePrompt({ type: "machine_readable_page", site, profile: {}, source: { kind: "manual", text: "R02: подготовить описание структуры страницы сайта" } });
    const parsed = parseArticleGeneration(complete(prompt));
    const validated = validateArticle(parsed, { type: "machine_readable_page", site });
    expect(validated.ok, JSON.stringify(validated.issues)).toBe(true);
    expect(validated.issues).toEqual([]);
    expect(validated.article.structuredData).toEqual({ "@type": "Organization", name: fixture.FAKE_WORDPRESS_HOST, url: site.canonicalUrl });
  });

  it("keeps unrelated AI outside its scope and rejects wrong WordPress credentials", () => {
    const res = responseSink();
    expect(fixture.handleFakeSitesAiRequest({ url: "/v1/chat/completions", method: "POST" }, res, JSON.stringify({ messages: [{ role: "system", content: "Ты — редактор сайта компании." }, { role: "user", content: "SITE: other.example.test" }] }))).toBe(false);
    expect(res.body).toBe("");
    expect(() => fixture.handleFakeSitesRequest({ headers: { host: fixture.FAKE_WORDPRESS_HOST }, method: "GET", url: "/wp-json/wp/v2/users/me" }, res, "")).toThrow("WordPress used the wrong account");
  });

  it("provides the article similarity embedder's dimension only for the dedicated synthetic article", () => {
    const res = responseSink();
    const req = { url: "/v1/embeddings", method: "POST" };
    expect(fixture.handleFakeSitesAiRequest(req, res, JSON.stringify({ input: "Unrelated project text" }))).toBe(false);
    expect(fixture.handleFakeSitesAiRequest(req, res, JSON.stringify({ input: `${fixture.FAKE_SITES_ARTICLE_TITLE} Проверка структуры` }))).toBe(true);
    const vector = JSON.parse(res.body).data[0].embedding;
    expect(vector).toHaveLength(EMBED_DIM);
    expect(vector.every(Number.isFinite)).toBe(true);
    expect(vector.reduce((sum, value) => sum + value * value, 0)).toBe(1);
    expect(fixture.handleFakeSitesAiRequest({ ...req, url: "/api/embed" }, res, JSON.stringify({ input: `${fixture.FAKE_SITES_ARTICLE_TITLE}\nПроверка структуры` }))).toBe(true);
    expect(JSON.parse(res.body).embeddings[0]).toEqual(vector);
  });
});


describe("Sites creation original response boundary", () => {
  function creationFixture() {
    const projectId=10, key="12345678-1234-1234-1234-123456789012";
    const url=`https://${fixture.FAKE_WORDPRESS_HOST}/`;
    const body={ok:true,created:true,analysisError:null,site:{id:21,projectId,canonicalUrl:url,
      verification:{state:"unverified",token:"synthetic-challenge-token"}},latestAnalysis:{id:31}};
    const request={method:()=>"POST",url:()=>"https://127.0.0.1:58801/api/sites",
      headers:()=>({"x-aurora-project-id":String(projectId),"idempotency-key":key}),postDataJSON:()=>({url,consent:true})};
    const response={request:()=>request,url:request.url,status:()=>201,
      json:vi.fn(async()=>{throw new Error("Network.getResponseBody: No data found");})};
    let consent=false, observe, responseResolve;
    const page={context:()=>{},evaluate:async()=>({viewport:1280,document:1280,body:1280}),
      locator:()=>({fill:async()=>{}}),on:(_event,fn)=>{observe=fn;},off:vi.fn(),
      getByText:()=>({waitFor:async()=>{}}),getByRole:role=>({
        getAttribute:async()=>"true",click:async()=>{
          if(role==="checkbox"){consent=true;return;}
          if(consent){observe(request);responseResolve(response);}
        },
      }),waitForResponse:predicate=>{expect(predicate(response)).toBe(true);return new Promise(resolve=>{responseResolve=resolve;});},
    };
    const afterReceipt=new Error("reached original analysis polling");
    return {body,response,afterReceipt,options:{page,projectId,userId:1,pool:{query:async()=>({rows:[{n:0}]})},
      navigate:async()=>{},waitFor:async()=>{throw afterReceipt;},readMutationReceipt:async()=>body}};
  }
  it("reaches durable analysis checks with the exact ingress receipt when CDP body is unavailable",async()=>{
    const f=creationFixture();
    await expect(fixture.runSitesCoverage(f.options)).rejects.toBe(f.afterReceipt);
    expect(f.response.json).not.toHaveBeenCalled();
  });
  it("retains a rejected original response proof before polling or another UI operation",async()=>{
    const f=creationFixture();const failure=new Error("original receipt correlation failed");
    await expect(fixture.runSitesCoverage({...f.options,readMutationReceipt:async()=>{throw failure;}})).rejects.toBe(failure);
  });
});
