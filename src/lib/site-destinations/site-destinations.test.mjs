import { describe, expect, it, vi } from "vitest";

import { assertSiteDestinationAdapter, createSiteDestinationAdapters, isSiteDestinationKind } from "./index.mjs";
import { createHostedAdapter, deriveHostedSlug, hostedArticleUrl, hostedSitesDomain, hostedSlugFromHost } from "./hosted.mjs";
import { createWordPressAdapter } from "./wordpress-adapter.mjs";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const destination = { id: 1, kind: "wordpress", baseUrl: "https://blog.example.ru", sectionPath: null, settings: {}, credentials: { username: "editor", appPassword: "abcd efgh ijkl mnop" } };
const payload = { slug: "skolko-stoit", title: "Сколько стоит", metaDescription: "desc", bodyHtml: "<p>text</p>", structuredData: { "@type": "FAQPage" }, publishAt: "2026-09-02T10:00:00.000Z" };

function jsonResponse(status, body) {
  return { status, text: async () => (body === undefined ? "" : JSON.stringify(body)) };
}

describe("site destination contract", () => {
  it("registers both adapters and enforces the fail-closed contract", () => {
    const adapters = createSiteDestinationAdapters({ wordpress: { lookupFn: publicLookup }, hosted: { env: { AURORA_SITES_DOMAIN: "sites.aurora.test" } } });
    expect(Object.keys(adapters).sort()).toEqual(["site_hosted", "wordpress"]);
    expect(isSiteDestinationKind("wordpress")).toBe(true);
    expect(isSiteDestinationKind("tilda")).toBe(false);
    expect(() => assertSiteDestinationAdapter({ id: "wordpress", publish() {}, reconcile() {}, verify() {}, update() {}, unpublish() {}, retryPolicy: "retry" })).toThrow("site_adapter_retry_policy_invalid");
    expect(() => assertSiteDestinationAdapter({ id: "wordpress", publish() {}, retryPolicy: "reconcile_before_retry" })).toThrow("site_adapter_verify_required");
  });
});

describe("WordPress adapter", () => {
  it("publishes with application-password auth and maps the created post", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe("https://blog.example.ru/wp-json/wp/v2/posts");
      expect(init.method).toBe("POST");
      expect(init.headers.authorization).toBe(`Basic ${Buffer.from("editor:abcdefghijklmnop").toString("base64")}`);
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({ slug: "skolko-stoit", title: "Сколько стоит", content: "<p>text</p>", status: "publish", date_gmt: "2026-09-02T10:00:00" });
      return jsonResponse(201, { id: 77, slug: "skolko-stoit", status: "publish", link: "https://blog.example.ru/skolko-stoit/" });
    });
    const adapter = createWordPressAdapter({ fetchImpl, lookupFn: publicLookup });
    const result = await adapter.publish(destination, payload);
    expect(result.ok).toBe(true);
    expect(result.providerOperationId).toBe("skolko-stoit");
    expect(result.providerRef).toMatchObject({ id: 77, slug: "skolko-stoit" });
    expect(result.publishedUrl).toBe("https://blog.example.ru/skolko-stoit/");
  });

  it("treats 5xx, non-JSON and network errors as delivery_unknown so the caller reconciles instead of re-posting", async () => {
    const adapter = createWordPressAdapter({ fetchImpl: vi.fn(async () => jsonResponse(502, { code: "upstream" })), lookupFn: publicLookup });
    const unknown = await adapter.publish(destination, payload);
    expect(unknown.outcome).toBe("delivery_unknown");
    expect(unknown.retryable).toBe(false);
    expect(unknown.providerOperationId).toBe("skolko-stoit");
    const html = createWordPressAdapter({ fetchImpl: vi.fn(async () => ({ status: 200, text: async () => "<html>maintenance</html>" })), lookupFn: publicLookup });
    expect((await html.publish(destination, payload)).outcome).toBe("delivery_unknown");
    const network = createWordPressAdapter({ fetchImpl: vi.fn(async () => { throw new Error("socket hang up"); }), lookupFn: publicLookup });
    expect((await network.publish(destination, payload)).outcome).toBe("delivery_unknown");
  });

  it("classifies auth, rate limit and validation failures", async () => {
    const auth = createWordPressAdapter({ fetchImpl: vi.fn(async () => jsonResponse(401, { code: "rest_not_logged_in" })), lookupFn: publicLookup });
    expect((await auth.publish(destination, payload))).toMatchObject({ outcome: "auth_failed", code: "rest_not_logged_in" });
    const limited = createWordPressAdapter({ fetchImpl: vi.fn(async () => jsonResponse(429, { code: "too_many" })), lookupFn: publicLookup });
    expect((await limited.publish(destination, payload))).toMatchObject({ outcome: "rate_limited", retryable: true });
    const invalid = createWordPressAdapter({ fetchImpl: vi.fn(async () => jsonResponse(400, { code: "rest_invalid_param" })), lookupFn: publicLookup });
    expect((await invalid.publish(destination, payload))).toMatchObject({ outcome: "definite_failure", code: "rest_invalid_param" });
    const missing = createWordPressAdapter({ fetchImpl: vi.fn(), lookupFn: publicLookup });
    expect((await missing.publish({ ...destination, credentials: null }, payload)).outcome).toBe("auth_failed");
  });

  it("refuses private addresses and redirects", async () => {
    const privateAdapter = createWordPressAdapter({ fetchImpl: vi.fn(), lookupFn: async () => [{ address: "10.0.0.5", family: 4 }] });
    const result = await privateAdapter.publish(destination, payload);
    expect(result).toMatchObject({ outcome: "definite_failure", reason: "private_address" });
    const redirecting = createWordPressAdapter({ fetchImpl: vi.fn(async () => ({ status: 301, text: async () => "" })), lookupFn: publicLookup });
    expect((await redirecting.publish(destination, payload)).reason).toBe("redirect_forbidden");
  });

  it("reconciles by slug and distinguishes an existing post from a confirmed absence", async () => {
    const found = createWordPressAdapter({
      fetchImpl: vi.fn(async (url) => {
        const parsed = new URL(url);
        expect(parsed.searchParams.get("slug")).toBe("skolko-stoit");
        expect(parsed.searchParams.get("status")).toContain("publish");
        return jsonResponse(200, [{ id: 77, slug: "skolko-stoit", status: "publish", link: "https://blog.example.ru/skolko-stoit/" }]);
      }),
      lookupFn: publicLookup,
    });
    expect(await found.reconcile(destination, "skolko-stoit")).toMatchObject({ ok: true, providerRef: { id: 77 }, publishedUrl: "https://blog.example.ru/skolko-stoit/" });
    const absent = createWordPressAdapter({ fetchImpl: vi.fn(async () => jsonResponse(200, [])), lookupFn: publicLookup });
    expect(await absent.reconcile(destination, "skolko-stoit")).toMatchObject({ ok: false, outcome: "definite_failure", reason: "not_found" });
  });

  it("verifies credentials and capability, updates and unpublishes to draft", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      if (url.includes("/users/me")) return jsonResponse(200, { id: 3, name: "Editor", capabilities: { publish_posts: true } });
      if (url.endsWith("/posts/77") && JSON.parse(init.body).status === "draft") return jsonResponse(200, { id: 77, slug: "skolko-stoit", status: "draft", link: null });
      if (url.endsWith("/posts/77")) return jsonResponse(200, { id: 77, slug: "skolko-stoit", status: "publish", link: "https://blog.example.ru/skolko-stoit/" });
      return jsonResponse(404, { code: "rest_post_invalid_id" });
    });
    const adapter = createWordPressAdapter({ fetchImpl, lookupFn: publicLookup, now: () => new Date("2026-09-02T00:00:00Z") });
    expect(await adapter.verify(destination)).toMatchObject({ ok: true, credentialState: "ready", permissionState: "ready", account: { id: 3, name: "Editor" } });
    expect(await adapter.update(destination, { id: 77 }, payload)).toMatchObject({ ok: true, publishedUrl: "https://blog.example.ru/skolko-stoit/" });
    expect(await adapter.unpublish(destination, { id: 77, slug: "skolko-stoit" })).toMatchObject({ ok: true, publishedUrl: null });
    expect(await adapter.update(destination, null, payload)).toMatchObject({ ok: false, reason: "provider_ref_missing" });
    const noCap = createWordPressAdapter({ fetchImpl: vi.fn(async () => jsonResponse(200, { id: 3, name: "Sub", capabilities: { read: true } })), lookupFn: publicLookup });
    expect(await noCap.verify(destination)).toMatchObject({ ok: false, permissionState: "missing", reason: "publish_posts_capability_missing" });
  });
});

describe("hosted section helpers and adapter", () => {
  const env = { AURORA_SITES_DOMAIN: "sites.aurora.test" };

  it("derives the sites domain, slugs and hosts", () => {
    expect(hostedSitesDomain(env)).toBe("sites.aurora.test");
    expect(hostedSitesDomain({ APP_URL: "https://app.aurora.ru" })).toBe("sites.app.aurora.ru");
    expect(hostedSitesDomain({})).toBeNull();
    expect(deriveHostedSlug("www.Clinic-Ulybka.ru")).toBe("clinic-ulybka-ru");
    expect(deriveHostedSlug("x")).toBeNull();
    expect(hostedSlugFromHost("clinic.sites.aurora.test:3000", env)).toBe("clinic");
    expect(hostedSlugFromHost("app.aurora.ru", env)).toBeNull();
    expect(hostedSlugFromHost("evil..sites.aurora.test", env)).toBeNull();
    expect(hostedArticleUrl("clinic", "skolko-stoit", env)).toBe("https://clinic.sites.aurora.test/skolko-stoit");
    expect(hostedArticleUrl("clinic", "x", { AURORA_SITES_DOMAIN: "sites.localhost" })).toBe("http://clinic.sites.localhost/x");
  });

  it("publishes deterministically and fails closed without a configured domain", async () => {
    const adapter = createHostedAdapter({ env });
    const dest = { id: 2, kind: "site_hosted", baseUrl: "https://clinic.sites.aurora.test", settings: { hostedSlug: "clinic" }, credentials: null };
    expect(await adapter.verify(dest)).toMatchObject({ ok: true, origin: "https://clinic.sites.aurora.test" });
    const published = await adapter.publish(dest, payload);
    expect(published).toMatchObject({ ok: true, publishedUrl: "https://clinic.sites.aurora.test/skolko-stoit", providerOperationId: "skolko-stoit" });
    expect(await adapter.reconcile(dest, "skolko-stoit")).toMatchObject({ ok: true, publishedUrl: "https://clinic.sites.aurora.test/skolko-stoit" });
    const unconfigured = createHostedAdapter({ env: {} });
    expect(await unconfigured.publish(dest, payload)).toMatchObject({ ok: false, reason: "hosted_domain_not_configured" });
  });
});
