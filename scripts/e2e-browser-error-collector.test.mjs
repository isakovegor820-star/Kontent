import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { createE2eBrowserErrorCollector } from "./e2e-browser-error-collector.mjs";

function fixture() {
  const baseUrl = "https://127.0.0.1:63345";
  const context = new EventEmitter(); context.pages = () => [];
  const collector = createE2eBrowserErrorCollector({ baseUrl }); collector.observeContext(context);
  const page = new EventEmitter();
  const response = ({ status = 401, error = "invalid", method = "POST", path = "/api/auth/login", observed = true } = {}) => {
    const request = { method: () => method, frame: () => ({ page: () => page }) };
    const result = { request: () => request, url: () => baseUrl + path, status: () => status, json: async () => ({ error }) };
    if (observed) context.emit("response", result);
    return result;
  };
  const message = ({ text = "Failed to load resource: the server responded with a status of 401 (Unauthorized)",
    url = baseUrl + "/api/auth/login", args = [], lineNumber = 0, columnNumber = 0 } = {}) => ({
    type: () => "error", text: () => text, location: () => ({ url, lineNumber, columnNumber }), args: () => args, page: () => page,
  });
  const expected = { method: "POST", path: "/api/auth/login", status: 401, error: "invalid" };
  return { baseUrl, context, page, collector, response, message, expected };
}
it("records early context errors before page creation, without duplicate page events or raw private data", () => {
  const { context, page, collector, message } = fixture(); const error = new Error("PRIVATE_RESET_TOKEN");
  context.emit("weberror", { error: () => error, page: () => page }); context.emit("page", page); page.emit("pageerror", error);
  const console = message({ text: "PRIVATE_RESET_TOKEN", url: "https://other.invalid/reset#PRIVATE_RESET_TOKEN", args: [1] });
  context.emit("console", console); page.emit("console", console); page.emit("crash");
  expect(collector.snapshot().unexpected.map((row) => row.kind)).toEqual(["pageerror", "crash", "console"]);
  expect(JSON.stringify(collector.snapshot())).not.toContain("PRIVATE_RESET_TOKEN");
  expect(() => collector.assertClean()).toThrow();
  collector.stop(); expect(context.listenerCount("weberror")).toBe(0); expect(page.listenerCount("console")).toBe(0);
});
it("records a context error without an available page", () => {
  const { context, collector } = fixture(); context.emit("weberror", { error: () => new Error("early error"), page: () => null });
  expect(collector.snapshot().unexpected).toEqual([{ kind: "pageerror", page: null }]);
});
it("accepts one native resource console only after the actual response action proves exact method/path/status/body", async () => {
  const { page, collector, response, message, expected } = fixture(); const received = response();
  page.emit("console", message()); await collector.expectHttpError(received, expected);
  collector.assertClean(); expect(collector.snapshot().knownHttpErrors).toEqual([{ page: 0, ...expected }]);
});
it.each([
  { method: "GET" }, { path: "/api/auth/other" }, { status: 422 }, { error: "unexpected_body" }, { observed: false },
])("does not admit a mismatched actual response: %j", async (delta) => {
  const { collector, response, expected } = fixture();
  await expect(collector.expectHttpError(response(delta), expected)).rejects.toThrow();
});
it.each([
  { args: ["same text from script"] }, { lineNumber: 1 }, { columnNumber: 1 },
  { text: "app failed with 401" }, { text: "Failed to load resource: the server responded with a status of 429 (Too Many Requests)" },
  { url: "https://127.0.0.1:63345/api/auth/other" },
])("does not excuse script/unknown console messages using an unrelated expected HTTP response: %j", async (delta) => {
  const { page, collector, response, message, expected } = fixture(); await collector.expectHttpError(response(), expected);
  page.emit("console", message(delta)); expect(() => collector.assertClean()).toThrow();
});
it("a previously silent expected request never masks a new unvalidated response of the same URL and status", async () => {
  const { page, collector, response, message, expected } = fixture(); await collector.expectHttpError(response(), expected);
  response({ error: "different_request_not_authorized" }); page.emit("console", message());
  expect(collector.snapshot().unexpected).toEqual([expect.objectContaining({ kind: "unexpected_http", status: 401 })]);
  expect(() => collector.assertClean()).toThrow();
});
it("does not duplicate a registered response to excuse additional resource messages", async () => {
  const { page, collector, response, message, expected } = fixture(); const actual = response(); await collector.expectHttpError(actual, expected);
  await expect(collector.expectHttpError(actual, expected)).rejects.toThrow("already registered");
  page.emit("console", message()); page.emit("console", message());
  expect(collector.snapshot().knownHttpErrors).toHaveLength(1); expect(collector.snapshot().unexpected).toHaveLength(1);
});
it("keeps a clean context and positive network responses clean", () => {
  const { collector, response } = fixture(); response({ status: 200 }); collector.stop(); collector.assertClean();
  expect(collector.snapshot().unexpected).toEqual([]);
});
