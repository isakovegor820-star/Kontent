export const TRACKING_CLIENT_SOURCE = String.raw`(() => {
  "use strict";
  const script = document.currentScript;
  if (!script || !script.src) return;
  const publicKey = (script.getAttribute("data-project-key") || "").trim();
  if (!/^[A-Za-z0-9_-]{20,160}$/.test(publicKey)) return;
  const apiOrigin = new URL(script.src, document.baseURI).origin;
  const storageKey = "aurora:attribution:" + publicKey;
  const allowedEvents = new Set(["form_open", "form_submit", "consultation_booked"]);

  const safeStorage = {
    get(key) {
      try { return window.localStorage.getItem(key); } catch { return null; }
    },
    set(key, value) {
      try { window.localStorage.setItem(key, value); return true; } catch { return false; }
    },
  };

  const pageUrl = new URL(window.location.href);
  const queryToken = pageUrl.searchParams.get("aurora_attribution");
  if (queryToken && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(queryToken) && queryToken.length <= 1200) {
    safeStorage.set(storageKey, queryToken);
    pageUrl.searchParams.delete("aurora_attribution");
    try {
      window.history.replaceState(window.history.state, "", pageUrl.pathname + pageUrl.search + pageUrl.hash);
    } catch {}
  }

  async function send(path, body, idempotencyKey) {
    try {
      const headers = {
        "content-type": "application/json",
        "x-aurora-project-key": publicKey,
      };
      if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
      const response = await fetch(apiOrigin + path, {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers,
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => null);
      return response.ok && result && result.ok === true
        ? result
        : { ok: false, status: response.status };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  function eventKey(eventType, supplied) {
    if (typeof supplied === "string" && /^[A-Za-z0-9._:-]{8,160}$/.test(supplied)) return supplied;
    return "event:" + crypto.randomUUID();
  }

  const ready = send("/api/tracking/ping", { publicKey });
  const client = {
    ready,
    track(eventType, idempotencyKey) {
      if (!allowedEvents.has(eventType)) {
        return Promise.resolve({ ok: false, error: "unsupported_event" });
      }
      const token = safeStorage.get(storageKey);
      if (!token) return Promise.resolve({ ok: false, error: "no_attribution" });
      return send("/api/tracking/conversions", {
        publicKey,
        token,
        eventType,
        occurredAt: new Date().toISOString(),
      }, eventKey(eventType, idempotencyKey));
    },
  };
  Object.defineProperty(window, "AuroraTracking", {
    value: Object.freeze(client),
    configurable: false,
    writable: false,
  });
})();
`;
