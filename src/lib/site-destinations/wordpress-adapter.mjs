import { SafeHttpError, parsePublicHttpUrl, resolvePublicTarget, requestPublicBuffer } from "../safe-http.mjs";
import {
  PROVIDER_DELIVERY_OUTCOMES,
  classifiedFailure,
  definiteFailure,
  deliveryUnknown,
  providerOperationIdFor,
  success,
} from "./contract.mjs";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export class WordPressAdapterError extends Error {
  constructor(code, message, { status = null } = {}) {
    super(message);
    this.name = "WordPressAdapterError";
    this.code = code;
    this.status = status;
  }
}

function normalizeBaseUrl(value) {
  const url = parsePublicHttpUrl(value);
  if (url.protocol !== "https:") throw new WordPressAdapterError("https_required", "WordPress: для пароля приложения требуется HTTPS");
  url.hash = "";
  url.search = "";
  // Принимаем и корень сайта, и уже готовый /wp-json.
  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = path.endsWith("/wp-json") ? path : `${path}/wp-json`;
  return url;
}

function basicAuth(credentials) {
  const username = String(credentials?.username || "").trim();
  const appPassword = String(credentials?.appPassword || "").replace(/\s+/gu, "");
  if (!username || !appPassword) throw new WordPressAdapterError("credentials_missing", "WordPress: нет логина или пароля приложения");
  return `Basic ${Buffer.from(`${username}:${appPassword}`, "utf8").toString("base64")}`;
}

async function readJson(response) {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new WordPressAdapterError("response_too_large", "WordPress: ответ слишком большой");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new WordPressAdapterError("response_not_json", "WordPress: ответ не является JSON", { status: response.status });
  }
}

export function wpPostToRef(post, baseUrl) {
  if (!post || typeof post !== "object") return null;
  if (!Number.isSafeInteger(Number(post.id)) || Number(post.id) <= 0 || typeof post.slug !== "string" || !post.slug) return null;
  const link = typeof post.link === "string" ? post.link : null;
  return {
    id: Number(post.id),
    slug: String(post.slug || ""),
    status: String(post.status || ""),
    link,
    modified: post.modified_gmt || post.modified || null,
    baseUrl: baseUrl ? String(baseUrl) : null,
  };
}

/**
 * Адаптер WordPress REST API (пароли приложений). Все запросы идут только на публичный адрес
 * (проверка DNS перед запросом — как в safe-http), любой не-JSON и 5xx классифицируются
 * как неизвестная доставка, чтобы повтор шёл через reconcile по slug, а не через второй POST.
 */
export function createWordPressAdapter({ fetchImpl, requestFn, lookupFn, timeoutMs = DEFAULT_TIMEOUT_MS, now = () => new Date() } = {}) {
  async function request(destination, path, { method = "GET", body = null, query = null } = {}) {
    const base = normalizeBaseUrl(destination.baseUrl);
    const url = new URL(`${base.pathname}${path}`, base);
    for (const [key, value] of Object.entries(query || {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    const init = {
      method,
      redirect: "manual",
      headers: {
        accept: "application/json",
        authorization: basicAuth(destination.credentials),
        "user-agent": "Aurora-SitePublisher/1.0",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    };
    let response;
    if (fetchImpl) {
      // Explicit test/embedded transport; production uses the pinned exchange below.
      await resolvePublicTarget(url, lookupFn);
      response = await fetchImpl(url.toString(), init);
    } else {
      const result = await requestPublicBuffer(url, {
        ...init, lookupFn, requestFn, timeoutMs, maxBytes: MAX_RESPONSE_BYTES, httpsOnly: true,
      });
      response = { status: result.status, text: async () => result.buffer.toString("utf8") };
    }
    if (response.status >= 300 && response.status < 400) {
      throw new WordPressAdapterError("redirect_forbidden", "WordPress: REST API перенаправляет запрос", { status: response.status });
    }
    const payload = await readJson(response);
    return { status: response.status, payload };
  }

  function classify(error) {
    if (error instanceof SafeHttpError) {
      // Failure before connecting is definite; a timeout/oversized reply may follow
      // a completed provider write and must never cause an automatic duplicate POST.
      if (["bad_url", "bad_protocol", "credentials", "bad_host", "private_address"].includes(error.code)) {
        return definiteFailure(error.code, { code: error.code });
      }
      return deliveryUnknown(null, error.code);
    }
    if (error instanceof WordPressAdapterError) {
      if (error.code === "credentials_missing") return classifiedFailure(PROVIDER_DELIVERY_OUTCOMES.AUTH_FAILED, error.code, { code: error.code });
      if (error.code === "response_not_json" || error.code === "response_too_large") return deliveryUnknown(null, error.code);
      return definiteFailure(error.code, { code: error.code, retryable: !["redirect_forbidden", "https_required"].includes(error.code) });
    }
    const code = typeof error?.name === "string" && error.name === "TimeoutError" ? "provider_timeout" : "network_error";
    return deliveryUnknown(null, code);
  }

  function failureFromStatus(status, payload, providerOperationId) {
    const wpCode = typeof payload?.code === "string" ? payload.code.slice(0, 80) : null;
    if (status === 401 || status === 403) return classifiedFailure(PROVIDER_DELIVERY_OUTCOMES.AUTH_FAILED, wpCode || "auth_failed", { code: wpCode, providerOperationId });
    if (status === 429) return classifiedFailure(PROVIDER_DELIVERY_OUTCOMES.RATE_LIMITED, wpCode || "rate_limited", { code: wpCode, providerOperationId, retryable: true });
    if (status >= 500) return deliveryUnknown(providerOperationId, wpCode || `http_${status}`);
    return definiteFailure(wpCode || `http_${status}`, { code: wpCode, providerOperationId });
  }

  function articleBody(payload, statusValue) {
    return {
      title: String(payload.title || "").slice(0, 200),
      slug: String(payload.slug || "").slice(0, 120),
      content: String(payload.bodyHtml || ""),
      excerpt: payload.metaDescription ? String(payload.metaDescription).slice(0, 320) : "",
      status: statusValue,
      ...(payload.publishAt ? { date_gmt: new Date(payload.publishAt).toISOString().replace(/\.\d{3}Z$/u, "") } : {}),
      ...(payload.categoryId ? { categories: [Number(payload.categoryId)] } : {}),
      meta: payload.structuredData ? { aurora_structured_data: JSON.stringify(payload.structuredData).slice(0, 20_000) } : {},
    };
  }

  return Object.freeze({
    id: "wordpress",
    composerSupported: false,
    retryPolicy: "reconcile_before_retry",

    async verify(destination) {
      try {
        const { status, payload } = await request(destination, "/wp/v2/users/me", { query: { context: "edit" } });
        if (status === 401 || status === 403) return { ok: false, credentialState: "invalid", permissionState: "denied", reason: "auth_failed" };
        if (status !== 200 || !payload) return { ok: false, credentialState: "unknown", permissionState: "unknown", reason: `http_${status}` };
        const capabilities = payload.capabilities || {};
        const canPublish = capabilities.publish_posts === true;
        return {
          ok: canPublish,
          credentialState: "ready",
          permissionState: canPublish ? "ready" : "missing",
          reason: canPublish ? null : "publish_posts_capability_missing",
          account: { id: Number(payload.id), name: String(payload.name || "").slice(0, 120) },
          checkedAt: now().toISOString(),
        };
      } catch (error) {
        const failure = classify(error);
        return {
          ok: false,
          credentialState: failure.outcome === PROVIDER_DELIVERY_OUTCOMES.AUTH_FAILED ? "invalid" : "unknown",
          permissionState: "unknown",
          reason: failure.reason,
        };
      }
    },

    async publish(destination, payload) {
      const providerOperationId = providerOperationIdFor(payload);
      try {
        const { status, payload: post } = await request(destination, "/wp/v2/posts", { method: "POST", body: articleBody(payload, "publish") });
        if (status === 201 || status === 200) {
          const ref = wpPostToRef(post, destination.baseUrl);
          if (!ref || post.status !== "publish") return deliveryUnknown(providerOperationId, "publication_response_invalid");
          return success(providerOperationId, { providerRef: ref, publishedUrl: ref?.link || null });
        }
        return failureFromStatus(status, post, providerOperationId);
      } catch (error) {
        const failure = classify(error);
        return { ...failure, providerOperationId: failure.providerOperationId ?? providerOperationId };
      }
    },

    async reconcile(destination, providerOperationId, { action = "publish", expectedPayload = null, providerRef = null } = {}) {
      try {
        const postId = Number(providerRef?.id);
        const knownPost = Number.isSafeInteger(postId) && postId > 0;
        const { status, payload } = await request(destination, knownPost ? `/wp/v2/posts/${postId}` : "/wp/v2/posts", {
          query: knownPost ? { context: "edit" } : { slug: providerOperationId, status: "publish,future,draft,pending,private", per_page: 5, context: "edit" },
        });
        if (status !== 200 || (!knownPost && !Array.isArray(payload))) return failureFromStatus(status, payload, providerOperationId);
        const match = knownPost ? payload : payload.find((post) => post?.slug === providerOperationId);
        if (!match) return definiteFailure("not_found", { code: "not_found", providerOperationId });
        const ref = wpPostToRef(match, destination.baseUrl);
        if (!ref) return deliveryUnknown(providerOperationId, "publication_response_invalid");
        if (action === "unpublish") {
          return ref.status === "draft"
            ? success(providerOperationId, { providerRef: ref, publishedUrl: null })
            : deliveryUnknown(providerOperationId, "unpublish_not_confirmed");
        }
        if (ref.status !== "publish") return deliveryUnknown(providerOperationId, "publication_not_public");
        // Slug equality alone can select a pre-existing, unrelated post. The worker
        // supplies the exact approved payload and only matching raw content is proof.
        if (expectedPayload && (match.title?.raw !== expectedPayload.title || match.content?.raw !== expectedPayload.bodyHtml)) {
          return deliveryUnknown(providerOperationId, "publication_content_unconfirmed");
        }
        return success(providerOperationId, { providerRef: ref, publishedUrl: ref.link });
      } catch (error) {
        const failure = classify(error);
        return { ...failure, providerOperationId: failure.providerOperationId ?? providerOperationId };
      }
    },

    async update(destination, providerRef, payload) {
      const providerOperationId = providerOperationIdFor(payload);
      const postId = Number(providerRef?.id);
      if (!Number.isSafeInteger(postId) || postId <= 0) return definiteFailure("provider_ref_missing", { providerOperationId });
      try {
        const { status, payload: post } = await request(destination, `/wp/v2/posts/${postId}`, { method: "POST", body: articleBody(payload, "publish") });
        if (status === 200) {
          const ref = wpPostToRef(post, destination.baseUrl);
          if (!ref || post.status !== "publish") return deliveryUnknown(providerOperationId, "publication_response_invalid");
          return success(providerOperationId, { providerRef: ref, publishedUrl: ref?.link || null });
        }
        return failureFromStatus(status, post, providerOperationId);
      } catch (error) {
        const failure = classify(error);
        return { ...failure, providerOperationId: failure.providerOperationId ?? providerOperationId };
      }
    },

    async unpublish(destination, providerRef) {
      const postId = Number(providerRef?.id);
      const providerOperationId = providerRef?.slug || null;
      if (!Number.isSafeInteger(postId) || postId <= 0) return definiteFailure("provider_ref_missing", { providerOperationId });
      try {
        // Не удаляем безвозвратно: статья уходит в черновики, чтобы владелец мог вернуть её.
        const { status, payload: post } = await request(destination, `/wp/v2/posts/${postId}`, { method: "POST", body: { status: "draft" } });
        if (status === 200) {
          const ref = wpPostToRef(post, destination.baseUrl);
          return ref?.status === "draft"
            ? success(providerOperationId, { providerRef: ref, publishedUrl: null })
            : deliveryUnknown(providerOperationId, "unpublish_not_confirmed");
        }
        if (status === 404) return success(providerOperationId, { providerRef: null, publishedUrl: null });
        return failureFromStatus(status, post, providerOperationId);
      } catch (error) {
        const failure = classify(error);
        return { ...failure, providerOperationId: failure.providerOperationId ?? providerOperationId };
      }
    },
  });
}
