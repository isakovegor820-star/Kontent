import { describe, expect, it, vi } from "vitest";
import { createWordPressAdapter } from "./wordpress-adapter.mjs";
const destination = { baseUrl: "https://blog.example.com", credentials: { username: "fixture", appPassword: "synthetic" } };
const payload = { title: "Fixture", slug: "immutable-fixture", bodyHtml: "<p>Fixture</p>" };
const lookupFn = async () => [{ address: "93.184.216.34", family: 4 }];
const json = (status, value) => ({ status, text: async () => JSON.stringify(value) });

describe("WordPress ambiguous delivery safety", () => {
  it("requires publish_posts rather than edit_posts alone to verify a publishing destination", async () => {
    const adapter = createWordPressAdapter({ fetchImpl: async () => json(200, { id: 7, capabilities: { edit_posts: true } }), lookupFn });
    expect(await adapter.verify(destination)).toMatchObject({ ok: false, permissionState: "missing", reason: "publish_posts_capability_missing" });
  });
  it.each([null, {}, { id: 0 }, { id: -1 }, { id: "not-id" }])("does not confirm a malformed successful receipt %j", async (receipt) => {
    const fetchImpl = vi.fn(async () => json(201, receipt));
    const adapter = createWordPressAdapter({ fetchImpl, lookupFn });
    expect(await adapter.publish(destination, payload)).toMatchObject({ ok: false, outcome: "delivery_unknown", retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("a missing slug after unknown delivery does not prove publication absence", async () => {
    // WordPress may rename an occupied slug, hide a post, or serve a stale replica.
    const fetchImpl = vi.fn(async () => json(200, []));
    const adapter = createWordPressAdapter({ fetchImpl, lookupFn });
    expect(await adapter.reconcile(destination, payload.slug)).toMatchObject({ ok: false, outcome: "delivery_unknown", retryable: false });
    expect(fetchImpl.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
  });
  it("a write redirect cannot prove the write did not execute", async () => {
    const adapter = createWordPressAdapter({ fetchImpl: async () => json(302, null), lookupFn });
    expect(await adapter.publish(destination, payload)).toMatchObject({ ok: false, outcome: "delivery_unknown", retryable: false });
  });
});
