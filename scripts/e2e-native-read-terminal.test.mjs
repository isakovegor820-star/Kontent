import { expect, it } from "vitest";
import { createMainRequestEvidence, readMainCancellationProof } from "./e2e-main-request-evidence.mjs";

const baseUrl = "https://localhost:12345";
function fixture(mode = "valid") {
  const page = { evaluate: async () => ({ documentId: "doc" }) };
  const evidence = createMainRequestEvidence({ baseUrl, now: () => 1100 });
  evidence.observeNative(page, { kind: "document", documentId: "doc" });
  const url = mode === "foreign-origin" ? "https://foreign.invalid/api/drafts/14" : baseUrl + "/api/drafts/14";
  const request = () => ({ url: () => url, method: () => mode === "mutation" ? "POST" : "GET",
    resourceType: () => mode === "image" ? "image" : "fetch",
    headers: () => ({ "x-aurora-e2e-read-id": mode === "no-identity" ? "" : "read-1" }),
    failure: () => ({ errorText: "net::ERR_CONNECTION_RESET" }) });
  const emit = (kind, at, extra = {}) => evidence.observeNative(page, { kind, at, id: 1,
    identity: "read-1", documentId: mode === "other-document" ? "other" : "doc", method: "GET",
    url: mode === "other-url" ? baseUrl + "/api/drafts/15" : url, ...extra });
  if (mode !== "no-native-call") emit("start", mode === "invalid-clock" ? NaN : 1000);
  const actual = request(); evidence.observeRequest(actual, "main", mode === "other-page" ? {} : page);
  if (mode === "duplicate-request") evidence.observeRequest(request(), "main", page);
  if (mode === "duplicate-call") emit("start", 1001, { id: 2 });
  if (mode === "collision") emit("collision", 1001);
  if (mode === "network-first") emit("failure", 1001, { callerAbort: false });
  if (mode !== "no-abort") emit("abort", mode === "abort-before-start" ? 999 : 1002);
  if (mode !== "pending") emit("failure", mode === "failure-before-abort" ? 1001 : 1003,
    { callerAbort: mode !== "network-failure" });
  if (mode === "body-started") emit("body-reader", 1004, { readerId: 1 });
  if (mode.startsWith("http-")) evidence.observeResponse({ request: () => actual, status: () => Number(mode.slice(5)), headers: () => ({}) });
  if (mode === "transport-reset") evidence.observeFailure(actual);
  return { evidence, page, actual };
}

it("settles the exactly matched caller-aborted fetch when Request has no transport terminal event", async () => {
  const f = fixture();
  await expect(f.evidence.settleReads(f.page, { timeoutMs: 60 })).resolves.toBeUndefined();
  expect(f.evidence.reason(f.actual)).toBe("native_caller_abort_without_transport_terminal");
  const row = f.evidence.snapshot()[0];
  expect(row.status).toBeNull(); expect(row.failure).toBeNull(); expect(row.finishedAt).toBeNull();
  const proof = f.evidence.proofs()[0];
  expect(readMainCancellationProof(proof).request).toBe(f.actual);
  expect(readMainCancellationProof({ ...proof })).toBeNull();
});

it.each(["pending", "no-abort", "network-failure", "network-first", "failure-before-abort",
  "abort-before-start", "invalid-clock", "no-native-call", "no-identity", "collision",
  "duplicate-request", "duplicate-call", "other-document", "other-page", "other-url", "foreign-origin",
  "mutation", "image", "body-started", "http-0", "http-200", "http-401", "http-500", "transport-reset"])("does not certify %s as missing-terminal caller cancellation", mode => {
  const f = fixture(mode);
  expect(f.evidence.reason(f.actual)).toBeNull(); expect(f.evidence.proofs()).toEqual([]);
});

it.each(["pending", "network-failure", "body-started", "http-401", "collision"])("navigation still fails for %s", async mode => {
  const f = fixture(mode);
  await expect(f.evidence.settleReads(f.page, { timeoutMs: 40 })).rejects.toThrow(/Captured GET/u);
});

it("revokes the proof if a later transport error contradicts the missing-terminal condition", () => {
  const f = fixture(); const proof = f.evidence.proofs()[0];
  expect(readMainCancellationProof(proof).request).toBe(f.actual);
  f.evidence.observeFailure(f.actual);
  expect(f.evidence.reason(f.actual)).toBeNull();
  expect(readMainCancellationProof(proof)).toBeNull();
});
