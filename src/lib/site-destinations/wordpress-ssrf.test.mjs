import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWordPressAdapter } from "./wordpress-adapter.mjs";

const destination = { baseUrl: "https://wordpress.example.test", credentials: { username: "fixture", appPassword: "synthetic-only" } };
const payload = { slug: "safe-fixture", title: "Fixture", bodyHtml: "<p>Fixture</p>" };
function socketFixture({ status = 201, chunks = [JSON.stringify({ id: 1, status: "publish", slug: "safe-fixture" })], headers = {} } = {}) {
  return vi.fn((_options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = vi.fn();
    req.destroy = (error) => queueMicrotask(() => req.emit("error", error));
    req.end = vi.fn(() => queueMicrotask(() => {
      const res = new EventEmitter(); res.statusCode = status; res.headers = headers;
      res.destroy = (error) => { if (error) queueMicrotask(() => res.emit("error", error)); };
      callback(res);
      for (const chunk of chunks) res.emit("data", Buffer.from(chunk));
      res.emit("end");
    }));
    return req;
  });
}
afterEach(() => vi.unstubAllGlobals());

describe("WordPress credential and SSRF transport safety", () => {
  it("pins the verified DNS address into the actual socket and retains TLS/Host identity", async () => {
    const requestFn = socketFixture();
    const lookupFn = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const unsafeFetch = vi.fn(async () => ({ status: 201, text: async () => JSON.stringify({ id: 1 }) }));
    vi.stubGlobal("fetch", unsafeFetch);
    const result = await createWordPressAdapter({ lookupFn, requestFn }).publish(destination, payload);
    expect(result.ok).toBe(true);
    expect(requestFn).toHaveBeenCalledOnce();
    expect(requestFn.mock.calls[0][0]).toMatchObject({ hostname: "93.184.216.34", servername: "wordpress.example.test", method: "POST", headers: { host: "wordpress.example.test" } });
    expect(unsafeFetch).not.toHaveBeenCalled();
    expect(lookupFn).toHaveBeenCalledOnce();
  });
  it("never sends application-password credentials over plaintext HTTP", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 201, text: async () => JSON.stringify({ id: 1 }) }));
    const result = await createWordPressAdapter({ fetchImpl, lookupFn: async () => [{ address: "93.184.216.34", family: 4 }] })
      .publish({ ...destination, baseUrl: "http://wordpress.example.test" }, payload);
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("stops an oversized response during receipt and retains delivery_unknown", async () => {
    const requestFn = socketFixture({ chunks: ["x".repeat(1024 * 1024 + 1)] });
    const result = await createWordPressAdapter({ requestFn, lookupFn: async () => [{ address: "93.184.216.34", family: 4 }] }).publish(destination, payload);
    expect(result).toMatchObject({ outcome: "delivery_unknown", retryable: false });
  });
});
