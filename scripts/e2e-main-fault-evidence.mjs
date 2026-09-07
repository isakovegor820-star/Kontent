import { readMainCancellationProof } from "./e2e-main-request-evidence.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const MAX_BODY_BYTES = 65_536;
const digest = (value) => createHash("sha256").update(value).digest("hex");

/** Browser-native HTTP diagnostics have no JavaScript arguments or source position. */
export function nativeMainHttpStatus(message) {
  const location = message.location();
  if (message.type() !== "error" || message.args().length !== 0 || location?.lineNumber !== 0 || location?.columnNumber !== 0) return null;
  const match = /^Failed to load resource: the server responded with a status of ([45][0-9]{2})(?: \([^\r\n]*\))?$/u.exec(message.text());
  return match ? Number(match[1]) : null;
}

/** Expected main-journey faults are proofs about actual requests, never time-window
 * exemptions. Forward every request/response/failure, even outside a scope.
 * Forward native consoles before general console handling; false means that the
 * caller must keep the diagnostic. After browser teardown begins, no console is
 * excused. Call finalize after all contexts close and transport cleanup settles. */
export function createMainFaultEvidence({ baseUrl }) {
  const origin = new URL(baseUrl).origin;
  const active = new Map(); const scopes = []; const requests = new Map(); const candidates = [];
  const consoleMessages = new WeakSet(); const work = []; let sequence = 0; let teardown = false;
  const href = (value) => new URL(value, baseUrl).href;
  const path = (value) => new URL(value).pathname;
  const currentScope = (label, page) => {
    const scope = active.get(label);
    return scope?.page === page ? scope : null;
  };
  function normalizeRule(rule) {
    assert(rule && typeof rule.method === "string", "fault rule method is required");
    const method = rule.method.toUpperCase();
    const url = typeof rule.url === "string" ? href(rule.url) : null;
    assert(url || (method === "GET" && rule.readOnly === true && typeof rule.matchUrl === "function"), "use an exact URL, or an explicit GET-only URL matcher");
    assert(!(url && rule.matchUrl), "fault URL rule must be unambiguous");
    if (url) assert.equal(new URL(url).origin, origin, "fault URL must belong to the isolated application");
    const base = { method, url, matchUrl: rule.matchUrl };
    if (rule.failure !== undefined) {
      const failures = Array.isArray(rule.failure) ? [...rule.failure] : [rule.failure];
      assert(failures.length > 0 && failures.every((value) => typeof value === "string" && value.length > 0), "exact failure values are required");
      assert(rule.explicitRouteAbort === true && rule.status === undefined && rule.jsonError === undefined && rule.text === undefined, "failure rules require an explicit route abort, not an HTTP response");
      return Object.freeze({ ...base, failures: Object.freeze(failures) });
    }
    assert(Number.isInteger(rule.status) && rule.status >= 400 && rule.status <= 599, "exact HTTP failure status is required");
    assert((typeof rule.jsonError === "string") !== (typeof rule.text === "string"), "exact JSON error or exact text is required");
    if (rule.jsonError !== undefined) assert(rule.jsonError.length > 0, "JSON error must not be empty");
    return Object.freeze({ ...base, status: rule.status, jsonError: rule.jsonError, text: rule.text });
  }
  function matchesUrl(rule, url) {
    const parsed = new URL(url);
    return parsed.origin === origin && (rule.url ? rule.url === url : rule.matchUrl(parsed) === true);
  }
  function getRequest(request, label, page, started = false) {
    const prior = requests.get(request);
    if (prior) return prior;
    const url = href(request.url()); const method = request.method(); const scope = currentScope(label, page);
    const eligible = started && !teardown && scope ? scope.rules.filter((rule) => rule.method === method && matchesUrl(rule, url)) : [];
    const row = { id: ++sequence, request, label, page, url, method, scope: started && !teardown ? scope : null,
      affected: Boolean(scope), eligible, responses: [], failure: null };
    requests.set(request, row); return row;
  }
  const nativeKind = (text) => {
    const status = /^Failed to load resource: the server responded with a status of ([45][0-9]{2})(?: \([^\r\n]*\))?$/u.exec(text)?.[1];
    if (status) return { status: Number(status) };
    const failure = /^Failed to load resource: ([^\r\n]+)$/u.exec(text)?.[1];
    return failure ? { failure } : null;
  };
  const matchesKind = (rule, kind) => kind.status !== undefined ? rule.status === kind.status : rule.failures?.includes(kind.failure);
  const hasKind = (row, kind) => kind.status !== undefined
    ? row.responses.some((response) => response.status === kind.status && response.status >= 400)
    : row.failure?.value === kind.failure;
  const provedKind = (row, kind) => kind.status !== undefined
    ? row.responses.some((response) => response.status === kind.status && response.proved)
    : row.failure?.proved && row.failure.value === kind.failure;
  const describe = (row) => ({ requestId: row.id, context: row.label, method: row.method, path: path(row.url) });

  return {
    beginScope(label, { page, rules, required = true }) {
      assert(!teardown, "cannot start an expected fault during teardown");
      assert(typeof label === "string" && label.length > 0 && page, "scope context and page are required");
      assert(!active.has(label), "fault scope already active for this context");
      assert(Array.isArray(rules) && rules.length > 0, "fault scope needs explicit rules");
      assert.equal(typeof required, "boolean", "required fault proof must be explicit boolean");
      const scope = { id: scopes.length + 1, label, page, rules: rules.map(normalizeRule), required, ended: false };
      scopes.push(scope); active.set(label, scope); return scope.id;
    },
    endScope(label) {
      const scope = active.get(label); assert(scope, "fault scope is not active");
      scope.ended = true; active.delete(label);
    },
    beginTeardown() { teardown = true; },
    observeRequest(request, label, page) { getRequest(request, label, page, true); },
    // true means defer this exact response to final body validation, never PASS.
    observeResponse(response, label, page) {
      const row = getRequest(response.request(), label, page);
      row.affected ||= Boolean(currentScope(label, page));
      const prior = row.responses.find((entry) => entry.response === response);
      if (prior) return prior.deferred;
      const entry = { response, status: response.status(), proved: false, deferred: false };
      row.responses.push(entry);
      if (row.failure) row.failure.proved = false;
      if (entry.status < 400) return false;
      const rules = row.eligible.filter((rule) => rule.status === entry.status);
      if (row.label !== label || row.page !== page || href(response.url()) !== row.url || rules.length === 0) return false;
      entry.deferred = true;
      const task = (async () => {
        const contentType = response.headers()["content-type"]?.split(";")[0].trim().toLowerCase();
        const body = await response.body();
        if (!Buffer.isBuffer(body) || body.length > MAX_BODY_BYTES) return;
        const text = body.toString("utf8"); let json;
        if (contentType === "application/json") { try { json = JSON.parse(text); } catch { return; } }
        entry.proved = rules.some((rule) => rule.jsonError !== undefined
          ? contentType === "application/json" && json?.error === rule.jsonError
          : contentType === "text/plain" && text === rule.text);
        if (entry.proved) { entry.bodySha256 = digest(body); entry.bytes = body.length; }
      })().catch(() => { entry.validationFailed = true; });
      // All asynchronous failures become unverified evidence; event handlers never
      // create an unhandled rejection or terminate before final aggregation.
      work.push(task);
      return true;
    },
    observeFailure(request, label, page, { explicitRouteAbort = false } = {}) {
      const row = getRequest(request, label, page); row.affected ||= Boolean(currentScope(label, page));
      const value = request.failure()?.errorText ?? "[missing failure]";
      const proved = row.label === label && row.page === page && explicitRouteAbort === true && row.responses.length === 0
        && row.eligible.some((rule) => rule.failures?.includes(value));
      // Re-observation cannot upgrade an unproved failure into a proved abort.
      row.failure ??= { value, proved };
    },
    recordNativeConsole(message, label, page) {
      if (teardown || message.type() !== "error") return false;
      if (consoleMessages.has(message)) return true;
      const location = message.location(); const kind = nativeKind(message.text());
      if (!kind || message.args().length !== 0 || location?.lineNumber !== 0 || location?.columnNumber !== 0) return false;
      let url; try { url = href(location.url); } catch { return false; }
      if (!location.url || new URL(url).origin !== origin) return false;
      const scope = currentScope(label, page);
      const potential = scope?.rules.some((rule) => matchesUrl(rule, url) && matchesKind(rule, kind))
        || [...requests.values()].some((row) => row.label === label && row.page === page && row.url === url
          && row.eligible.some((rule) => matchesKind(rule, kind)));
      if (!potential) return false;
      consoleMessages.add(message); candidates.push({ id: ++sequence, label, page, url, ...kind }); return true;
    },
    provedResponses(page, status, pathname) {
      return [...requests.values()].filter(row => row.page === page && row.method === "GET" && path(row.url) === pathname
        && row.responses.some(entry => entry.proved && entry.status === status)).map(row => row.request);
    },
    provedFailure(request) { return requests.get(request)?.failure?.proved === true; },
    async finalize({ cancellations = [] } = {}) {
      let drained = 0;
      while (drained < work.length) { const batch = work.slice(drained); drained += batch.length; await Promise.all(batch); }
      const issues = []; const observations = []; const consumed = new Set();
      const permittedCancellation = row => cancellations.some(proof => {
        const certificate = readMainCancellationProof(proof);
        return certificate?.request === row.request && certificate.page === row.page && certificate.url === row.url
          && certificate.failure === row.failure?.value;
      });
      for (const row of requests.values()) {
        const alias = candidates.some((candidate) => candidate.label === row.label && candidate.page === row.page
          && candidate.url === row.url && hasKind(row, candidate));
        if (!row.affected && !alias) continue;
        for (const response of row.responses) if (response.status >= 400 && !response.proved) {
          issues.push({ kind: "unverified_fault_response", ...describe(row), status: response.status });
        }
        if (row.failure && !row.failure.proved && !permittedCancellation(row)) issues.push({ kind: "unverified_fault_request", ...describe(row), failureSha256: digest(row.failure.value) });
      }
      for (const candidate of candidates) {
        const sameResource = [...requests.values()].filter((row) => row.label === candidate.label && row.page === candidate.page && row.url === candidate.url);
        const ambiguous = sameResource.some((row) => hasKind(row, candidate) && !provedKind(row, candidate));
        const proved = !ambiguous && sameResource.find((row) => row.id < candidate.id && provedKind(row, candidate) && !consumed.has(row.request));
        if (!proved) issues.push({ kind: "unverified_fault_console", context: candidate.label, path: path(candidate.url), ...(candidate.status ? { status: candidate.status } : {}) });
        else { consumed.add(proved.request); observations.push({ kind: "proved_fault_resource", ...describe(proved), ...(candidate.status ? { status: candidate.status } : { failure: candidate.failure }) }); }
      }
      for (const scope of scopes) {
        if (!scope.ended) issues.push({ kind: "fault_scope_not_closed", context: scope.label, scopeId: scope.id });
        if (scope.required && ![...requests.values()].some((row) => row.scope === scope && (row.failure?.proved || row.responses.some((response) => response.proved)))) {
          issues.push({ kind: "required_fault_not_proved", context: scope.label, scopeId: scope.id });
        }
      }
      return { issues, observations, proofs: [...requests.values()].flatMap((row) => [
        ...row.responses.filter((entry) => entry.proved).map((entry) => ({ ...describe(row), status: entry.status, bytes: entry.bytes, bodySha256: entry.bodySha256 })),
        ...(row.failure?.proved ? [{ ...describe(row), failure: row.failure.value, explicitRouteAbort: true }] : []),
      ]) };
    },
  };
}
