import assert from "node:assert/strict";

// Observe the original local upstream response without replacing/fulfilling it.
// Chromium can discard CDP response bodies after the app has already consumed
// them. Request-ID correlation retains the exact safety assertion at the ingress.
export function createAiConflictResponseEvidence() { return createJsonResponseEvidence("conflict"); }

/** Retain the original bounded ACK receipt at the owned TLS ingress. */
export function createAiAcknowledgementEvidence() { return createJsonResponseEvidence("ack"); }

/** Sites creation bodies use the same bounded original-ingress capture. */
export function createSitesMutationResponseEvidence() { return createJsonResponseEvidence("sites"); }
const sitesStatus = path => path === "/api/sites" ? 201 : /^\/api\/sites\/[1-9]\d*\/articles$/u.test(path) ? 202 : null;

export async function readSitesMutationReceipt({ evidence, response, baseUrl, projectId, waitFor }) {
  const url = new URL(response.url()); const request = response.request();
  assert.equal(url.origin, new URL(baseUrl).origin, "Sites receipt must use the owned ingress");
  assert.equal(url.search, ""); assert.equal(request.method(), "POST");
  assert(sitesStatus(url.pathname), "Sites receipt path is outside the creation contract");
  assert.equal(response.status(), sitesStatus(url.pathname));
  assert.equal(request.headers()["x-aurora-project-id"], String(projectId));
  assert.equal(response.headers()["content-type"]?.split(";")[0], "application/json");
  const id = response.headers()["x-request-id"];
  assert(typeof id === "string" && id.length > 0 && id.length <= 128, "Sites receipt requires response identity");
  const record = await waitFor(() => {
    const found = evidence.read(id);
    if (found?.error) throw new Error(`Sites original response failed: ${found.error}`);
    return found?.complete ? found : null;
  }, "Sites original response did not complete");
  assert.equal(record.requestId, id); assert.equal(record.path, url.pathname);
  assert.equal(record.status, response.status()); assert.equal(record.projectId, String(projectId));
  assert.equal(record.requestKey, request.headers()["idempotency-key"] ?? null);
  assert.equal(record.body?.requestId, id, "Sites body and response identity differ");
  return record.body;
}

function createJsonResponseEvidence(kind) {
  const records = new Map();
  return {
    observe(response, { method, path, headers = {} }) {
      const acknowledgement = kind === "ack"; const sites = kind === "sites";
      if (method !== "POST") return;
      if (sites) {
        if (!sitesStatus(path) || response.statusCode !== sitesStatus(path)
          || response.headers["content-type"]?.split(";")[0] !== "application/json"
          || !/^[1-9]\d*$/u.test(headers["x-aurora-project-id"] ?? "")
          || (path === "/api/sites" && !/^[A-Za-z0-9:_-]{8,96}$/u.test(headers["idempotency-key"] ?? ""))) return;
      } else if (acknowledgement
        ? path !== "/api/ai/generate/ack" || response.statusCode !== 200
          || response.headers["x-ai-acknowledged"] !== "true"
          || response.headers["content-type"]?.split(";")[0] !== "application/json"
          || typeof headers["idempotency-key"] !== "string" || !/^[A-Za-z0-9:_-]{8,96}$/u.test(headers["idempotency-key"])
        : path !== "/api/ai/generate" || ![409, 422].includes(response.statusCode)) return;
      const requestId = response.headers[sites ? "x-request-id" : "x-ai-request-id"];
      if (typeof requestId !== "string" || !requestId || requestId.length > 128) return;
      if (records.has(requestId)) {
        records.set(requestId, { error: "duplicate_response_id" });
        return;
      }
      const record = { requestId, status: response.statusCode, complete: false, body: null, error: null,
        ...(acknowledgement ? { requestKey: headers["idempotency-key"] } : {}),
        ...(sites ? { path, projectId: headers["x-aurora-project-id"], requestKey: headers["idempotency-key"] ?? null } : {}) };
      records.set(requestId, record);
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes <= 65_536) chunks.push(Buffer.from(chunk));
        else record.error = "response_too_large";
      });
      response.once("aborted", () => { record.error = "response_aborted"; });
      response.once("error", () => { record.error = "response_failed"; });
      response.once("end", () => {
        if (record.error || !response.complete) { record.error ??= "response_incomplete"; return; }
        try {
          record.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          record.complete = true;
        } catch { record.error = "invalid_json"; }
      });
    },
    read(requestId) { return records.get(requestId) ?? null; },
  };
}
