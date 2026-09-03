import { definiteFailure, providerOperationIdFor, success } from "./contract.mjs";

/**
 * Хостируемый раздел живёт на служебном поддомене продукта: <slug>.<AURORA_SITES_DOMAIN>.
 * Решение 13.1: wildcard-сертификат на один домен, кастомные домены клиентов — подэтап 2b.
 */
export function hostedSitesDomain(env = process.env) {
  const configured = String(env.AURORA_SITES_DOMAIN || "").trim().toLowerCase().replace(/^\.+|\.+$/gu, "");
  if (configured) return configured;
  try {
    const app = new URL(String(env.APP_URL || ""));
    return `sites.${app.hostname.toLowerCase()}`;
  } catch {
    return null;
  }
}

export function hostedSectionOrigin(slug, env = process.env) {
  const domain = hostedSitesDomain(env);
  if (!domain || !slug) return null;
  const protocol = domain.endsWith(".localhost") || domain === "localhost" ? "http" : "https";
  return `${protocol}://${slug}.${domain}`;
}

export function hostedArticleUrl(slug, articleSlug, env = process.env) {
  const origin = hostedSectionOrigin(slug, env);
  return origin ? `${origin}/${articleSlug}` : null;
}

/** Возвращает slug сайта, если Host запроса относится к хостируемому разделу. */
export function hostedSlugFromHost(hostHeader, env = process.env) {
  const domain = hostedSitesDomain(env);
  if (!domain) return null;
  const host = String(hostHeader || "").trim().toLowerCase().replace(/:\d+$/u, "");
  if (!host.endsWith(`.${domain}`)) return null;
  const slug = host.slice(0, -(domain.length + 1));
  return /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u.test(slug) ? slug : null;
}

export function deriveHostedSlug(confirmedDomain) {
  const base = String(confirmedDomain || "")
    .toLowerCase()
    .replace(/^www\./u, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 63)
    .replace(/-+$/u, "");
  return base.length >= 2 ? base : null;
}

/**
 * Адаптер хостируемого раздела: публикация — это факт в нашей же базе, поэтому publish
 * и reconcile детерминированы. Сеть здесь не участвует.
 */
export function createHostedAdapter({ env = process.env } = {}) {
  const urlFor = (destination, payload) => hostedArticleUrl(destination?.settings?.hostedSlug || destination?.hostedSlug, payload.slug, env);
  return Object.freeze({
    id: "site_hosted",
    composerSupported: false,
    retryPolicy: "reconcile_before_retry",
    async verify(destination) {
      const slug = destination?.settings?.hostedSlug || destination?.hostedSlug;
      const origin = hostedSectionOrigin(slug, env);
      if (!origin) return { ok: false, credentialState: "not_required", permissionState: "missing", reason: "hosted_domain_not_configured" };
      return { ok: true, credentialState: "not_required", permissionState: "ready", reason: null, origin };
    },
    async publish(destination, payload) {
      const providerOperationId = providerOperationIdFor(payload);
      const url = urlFor(destination, payload);
      if (!url) return definiteFailure("hosted_domain_not_configured", { providerOperationId });
      return success(providerOperationId, { providerRef: { slug: payload.slug, url }, publishedUrl: url });
    },
    async reconcile(destination, providerOperationId) {
      const url = hostedArticleUrl(destination?.settings?.hostedSlug || destination?.hostedSlug, providerOperationId, env);
      if (!url) return definiteFailure("hosted_domain_not_configured", { providerOperationId });
      return success(providerOperationId, { providerRef: { slug: providerOperationId, url }, publishedUrl: url });
    },
    async update(destination, providerRef, payload) {
      return this.publish(destination, payload);
    },
    async unpublish(destination, providerRef) {
      return success(providerRef?.slug || null, { providerRef: null, publishedUrl: null });
    },
  });
}
