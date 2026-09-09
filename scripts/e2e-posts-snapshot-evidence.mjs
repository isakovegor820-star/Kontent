import { createMainFaultEvidence, nativeMainHttpStatus } from "./e2e-main-fault-evidence.mjs";

/** A cursor invalidation is a documented read protocol outcome, not a blanket
 * 409 exemption. Reuse the exact Request/response-body/native-console verifier. */
export function createPostsSnapshotEvidence({ baseUrl }) {
  const origin = new URL(baseUrl).origin;
  const faults = createMainFaultEvidence({ baseUrl });
  const pages = new Map(); const requests = new Map(); let closed = false;
  const isCursorUrl = url => url.origin === origin && url.pathname === "/api/posts"
    && Boolean(url.searchParams.get("cursor"));
  return {
    observeRequest(request, context, page) {
      if (closed || requests.has(request)) return;
      const url = new URL(request.url()); if (!isCursorUrl(url)) return;
      let entry = pages.get(page);
      if (!entry) {
        entry = { page, context, label: `${context}:posts-snapshot-${pages.size + 1}`, urls: new Set() };
        pages.set(page, entry);
        faults.beginScope(entry.label, { page, required: false,
          rules: [{ method: "GET", readOnly: true, matchUrl: isCursorUrl, status: 409, jsonError: "posts_snapshot_changed" }] });
      }
      if (entry.context !== context) return;
      // Retain other methods at the same URL as ambiguity evidence. They never
      // match the GET rule and cannot borrow a GET's native resource diagnostic.
      requests.set(request, entry); entry.urls.add(url.href);
      faults.observeRequest(request, entry.label, page);
    },
    observeResponse(response, context, page) {
      const entry = requests.get(response.request());
      // Other statuses retain their normal main-harness fault handling.
      if (!entry || entry.context !== context || entry.page !== page || response.status() !== 409) return false;
      return faults.observeResponse(response, entry.label, page);
    },
    recordNativeConsole(message, context, page) {
      if (closed || nativeMainHttpStatus(message) !== 409) return false;
      const entry = pages.get(page); if (!entry || entry.context !== context) return false;
      let url; try { url = new URL(message.location().url).href; } catch { return false; }
      if (!entry.urls.has(url)) return false;
      return faults.recordNativeConsole(message, entry.label, page);
    },
    beginTeardown() {
      if (closed) return;
      closed = true;
      for (const entry of pages.values()) faults.endScope(entry.label);
      faults.beginTeardown();
    },
    finalize(options) { return faults.finalize(options); },
  };
}
