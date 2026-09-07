// Observe the original local upstream response without replacing/fulfilling it.
// Chromium can discard CDP response bodies after the app has already consumed
// them. Request-ID correlation retains the exact safety assertion at the ingress.
export function createAiConflictResponseEvidence() { return createJsonResponseEvidence("conflict"); }

/** Retain the original bounded ACK receipt at the owned TLS ingress. */
export function createAiAcknowledgementEvidence() { return createJsonResponseEvidence("ack"); }

function createJsonResponseEvidence(kind) {
  const records = new Map();
  return {
    observe(response, { method, path, headers = {} }) {
      const acknowledgement = kind === "ack";
      if (method !== "POST") return;
      if (acknowledgement
        ? path !== "/api/ai/generate/ack" || response.statusCode !== 200
          || response.headers["x-ai-acknowledged"] !== "true"
          || response.headers["content-type"]?.split(";")[0] !== "application/json"
          || typeof headers["idempotency-key"] !== "string" || !/^[A-Za-z0-9:_-]{8,96}$/u.test(headers["idempotency-key"])
        : path !== "/api/ai/generate" || ![409, 422].includes(response.statusCode)) return;
      const requestId = response.headers["x-ai-request-id"];
      if (typeof requestId !== "string" || !requestId || requestId.length > 128) return;
      if (records.has(requestId)) {
        records.set(requestId, { error: "duplicate_response_id" });
        return;
      }
      const record = { requestId, status: response.statusCode, complete: false, body: null, error: null,
        ...(acknowledgement ? { requestKey: headers["idempotency-key"] } : {}) };
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
