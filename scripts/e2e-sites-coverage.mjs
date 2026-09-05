import assert from "node:assert/strict";

export const FAKE_WORDPRESS_HOST = "wordpress.aurora.test";
export const fakeSitesState = { token: "synthetic-site-proof", posts: new Map(), writes: [] };

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
  if (url.pathname === "/" && req.method === "GET") {
    res.setHeader("content-type", "text/html");
    res.end(`<html><head><meta name="aurora-site-verification" content="${fakeSitesState.token}"></head><body>Disposable site</body></html>`);
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

export async function runSitesCoverage({ page, pool, userId, projectId, waitFor, artifactDir, captureScreenshot }) {
  const siteId = Number((await pool.query(`insert into sites(project_id,user_id,confirmed_domain,canonical_url,verification_token,hosted_slug,brand_name)
    values($1,$2,$3,$4,$5,'audit-e2e','Sites Audit Fixture') returning id`, [projectId, userId, FAKE_WORDPRESS_HOST, `https://${FAKE_WORDPRESS_HOST}/`, fakeSitesState.token])).rows[0].id);
  const articleId = Number((await pool.query(`insert into site_articles(site_id,project_id,user_id,article_type,origin,slug,status,title,body_markdown,body_html)
    values($1,$2,$3,'audience_answer','manual','reviewed-fixture','needs_review','Reviewed Sites fixture','Exact reviewed synthetic content','<p>Exact reviewed synthetic content</p>') returning id`, [siteId, projectId, userId])).rows[0].id);
  await page.goto("/app/sites");
  await page.getByRole("button", { name: "Проверить", exact: true }).click();
  await waitFor(async () => (await pool.query("select verification_state from sites where id=$1", [siteId])).rows[0].verification_state === "verified", "Sites domain ownership did not verify via the fake document head");
  await page.getByRole("tab", { name: "Публикация", exact: true }).click();
  await page.getByRole("button", { name: "Включить раздел", exact: true }).click();
  await waitFor(async () => Number((await pool.query("select count(*) as n from site_destinations where site_id=$1 and kind='site_hosted' and status='active'", [siteId])).rows[0].n) === 1, "hosted destination did not persist");
  await page.locator("#wp-url").fill(`https://${FAKE_WORDPRESS_HOST}`);
  await page.locator("#wp-user").fill("fixture");
  await page.locator("#wp-pass").fill("fixture-app-password");
  await page.getByRole("button", { name: "Подключить и проверить", exact: true }).click();
  await waitFor(async () => Number((await pool.query("select count(*) as n from site_destinations where site_id=$1 and kind='wordpress' and credential_state='ready'", [siteId])).rows[0].n) === 1, "WordPress account did not verify and save");
  assert.equal(await page.locator("#wp-pass").inputValue(), "", "WordPress credential remained in the form");
  const stored = (await pool.query("select credentials from site_destinations where site_id=$1 and kind='wordpress'", [siteId])).rows[0].credentials;
  assert(stored && !stored.includes("fixture-app-password"), "WordPress credential was not encrypted");
  await page.getByRole("tab", { name: "Материалы", exact: true }).click();
  await page.getByRole("button", { name: /Reviewed Sites fixture/u }).click();
  await page.getByRole("heading", { name: "Reviewed Sites fixture", exact: true }).waitFor();
  await page.getByRole("button", { name: "Одобрить", exact: true }).click();
  await waitFor(async () => Number((await pool.query("select count(*) as n from site_article_publications where article_id=$1 and action='publish' and status='published'", [articleId])).rows[0].n) === 2, "both Sites destinations must publish the reviewed revision", 60_000);
  assert.equal(fakeSitesState.writes.length, 1, "WordPress published more than once");
  assert.equal(fakeSitesState.writes[0].content, "<p>Exact reviewed synthetic content</p>");
  await page.reload();
  await page.getByRole("tab", { name: "Материалы", exact: true }).click();
  await page.getByRole("button", { name: /Reviewed Sites fixture/u }).click();
  await page.getByRole("button", { name: "Снять с публикации", exact: true }).click();
  await waitFor(async () => Number((await pool.query("select count(*) as n from site_article_publications where article_id=$1 and action='unpublish' and status='published'", [articleId])).rows[0].n) === 2, "both Sites destinations must unpublish using their own receipts", 60_000);
  assert.equal(fakeSitesState.writes.length, 2);
  assert.equal(fakeSitesState.writes[1].id, fakeSitesState.writes[0].id, "unpublish used a different WordPress destination receipt");
  assert.equal(fakeSitesState.writes[1].status, "draft");
  await captureScreenshot(page, { path: `${artifactDir}/interface-sites.png`, fullPage: true });
  return { siteId, articleId, domainVerifiedThroughUi: true, encryptedCredentials: true, destinations: 2, wordpressWrites: 2, exactApprovedContent: true, unpublishOwnReceipt: true };
}
