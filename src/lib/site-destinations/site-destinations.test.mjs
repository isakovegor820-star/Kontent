import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { assertSiteDestinationAdapter, createSiteDestinationAdapters, isSiteDestinationKind, encryptDestinationCredentials, loadSiteDestinationRuntime } from "./index.mjs";
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
  afterEach(() => vi.unstubAllGlobals());

  it("pins the verified address for the actual authenticated connection", async () => {
    // A global fetch implementation would resolve the hostname again (DNS rebinding).
    const unpinnedFetch = vi.fn(async () => jsonResponse(201, { id: 77, slug: payload.slug, status: "publish" }));
    vi.stubGlobal("fetch", unpinnedFetch);
    const lookupFn = vi.fn(publicLookup);
    const requestFn = vi.fn((options, respond) => {
      expect(options).toMatchObject({ hostname: "93.184.216.34", servername: "blog.example.ru", method: "POST" });
      expect(options.headers.host).toBe("blog.example.ru");
      const request = new EventEmitter();
      request.setTimeout = vi.fn();
      request.end = (body) => {
        expect(JSON.parse(body).slug).toBe(payload.slug);
        queueMicrotask(() => {
          const response = new EventEmitter();
          response.statusCode = 201;
          response.headers = {};
          respond(response);
          response.emit("data", Buffer.from(JSON.stringify({ id: 77, slug: payload.slug, status: "publish" })));
          response.emit("end");
        });
      };
      return request;
    });
    const result = await createWordPressAdapter({ lookupFn, requestFn }).publish(destination, payload);
    expect(result.ok).toBe(true);
    expect(requestFn).toHaveBeenCalledOnce();
    expect(lookupFn).toHaveBeenCalledOnce();
    expect(unpinnedFetch).not.toHaveBeenCalled();
  });

  it("does not send application credentials over plaintext HTTP", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { id: 77, slug: payload.slug, status: "publish" }));
    const result = await createWordPressAdapter({ fetchImpl, lookupFn: publicLookup })
      .publish({ ...destination, baseUrl: "http://blog.example.ru" }, payload);
    expect(result).toMatchObject({ ok: false, reason: "https_required" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not treat edit_posts alone as permission to publish", async () => {
    const adapter = createWordPressAdapter({ fetchImpl: async () => jsonResponse(200, { id: 3, capabilities: { edit_posts: true } }), lookupFn: publicLookup });
    expect(await adapter.verify(destination)).toMatchObject({ ok: false, permissionState: "missing" });
  });

  it("does not accept a malformed successful publication response", async () => {
    const adapter = createWordPressAdapter({ fetchImpl: async () => jsonResponse(201, {}), lookupFn: publicLookup });
    expect(await adapter.publish(destination, payload)).toMatchObject({ ok: false, outcome: "delivery_unknown" });
  });

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

  it("does not confuse a draft or unrelated same-slug post with confirmed delivery", async () => {
    const draft = createWordPressAdapter({ fetchImpl: async () => jsonResponse(200, [{ id: 77, slug: payload.slug, status: "draft" }]), lookupFn: publicLookup });
    expect(await draft.reconcile(destination, payload.slug)).toMatchObject({ ok: false, outcome: "delivery_unknown" });
    const unrelated = createWordPressAdapter({ fetchImpl: async () => jsonResponse(200, [{ id: 77, slug: payload.slug, status: "publish", title: { raw: "Other" }, content: { raw: "Other content" } }]), lookupFn: publicLookup });
    expect(await unrelated.reconcile(destination, payload.slug, { expectedPayload: payload })).toMatchObject({ ok: false, reason: "publication_content_unconfirmed" });
  });

  it("checks a known destination-specific ID when reconciling unpublish", async () => {
    const fetchImpl = vi.fn(async (url) => {
      expect(new URL(url).pathname).toBe("/wp-json/wp/v2/posts/77");
      return jsonResponse(200, { id: 77, slug: payload.slug, status: "draft" });
    });
    const adapter = createWordPressAdapter({ fetchImpl, lookupFn: publicLookup });
    expect(await adapter.reconcile(destination, payload.slug, { action: "unpublish", providerRef: { id: 77 } }))
      .toMatchObject({ ok: true, publishedUrl: null });
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


describe("destination credential context", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("does not fall back to audit actors when the encryption key is missing", async () => {
    vi.stubEnv("TOKENS_MASTER_KEY", "isolated-credential-test-key");
    const credentials = encryptDestinationCredentials({ username: "test", appPassword: "test-password" }, { userId: 9 });
    vi.stubEnv("TOKENS_MASTER_KEY", "");
    const db = { query: vi.fn() };
    await expect(loadSiteDestinationRuntime(db, { id: 7, site_id: 5, kind: "wordpress", credentials }, { id: 5, user_id: 9, project_id: 3 })).rejects.toMatchObject({ code: "token_key_missing" });
    expect(db.query).not.toHaveBeenCalled();
  });
});
