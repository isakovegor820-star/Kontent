import {
  PROVIDER_DELIVERY_OUTCOMES,
  classifiedFailure,
  definiteFailure,
  deliveryUnknown,
} from "../social-provider-contract.mjs";

export { PROVIDER_DELIVERY_OUTCOMES, classifiedFailure, definiteFailure, deliveryUnknown };

export const SITE_DESTINATION_KINDS = Object.freeze(["wordpress", "site_hosted"]);
export const SITE_ARTICLE_ACTIONS = Object.freeze(["publish", "update", "unpublish"]);

/**
 * Реестр возможностей назначений «сайт». Отдельный от provider-capabilities.mjs намеренно:
 * тот каталог описывает каналы соцсетей (channels.network) и его перечисление используется
 * в UI и в проверках публикаций постов; статьи — другой payload и другой жизненный цикл.
 */
export const SITE_DESTINATION_CAPABILITIES = Object.freeze({
  wordpress: Object.freeze({
    id: "wordpress",
    label: "WordPress",
    connection: Object.freeze({ kind: "application_password", requiresCredentials: true }),
    payloadKinds: Object.freeze(["article"]),
    capabilities: Object.freeze({ publish: true, update: true, unpublish: true, exportPackage: true, analytics: false }),
    limits: Object.freeze({ titleChars: 200, slugChars: 120, bodyChars: 200_000, authority: "provider" }),
  }),
  site_hosted: Object.freeze({
    id: "site_hosted",
    label: "Раздел, который ведёт Аврора",
    connection: Object.freeze({ kind: "domain_verification", requiresCredentials: false }),
    payloadKinds: Object.freeze(["article"]),
    capabilities: Object.freeze({ publish: true, update: true, unpublish: true, exportPackage: true, analytics: true }),
    limits: Object.freeze({ titleChars: 200, slugChars: 120, bodyChars: 200_000, authority: "product" }),
  }),
});

export function isSiteDestinationKind(value) {
  return SITE_DESTINATION_KINDS.includes(String(value));
}

export function success(providerOperationId, { providerRef = null, publishedUrl = null } = {}) {
  return {
    ok: true,
    outcome: PROVIDER_DELIVERY_OUTCOMES.SUCCESS,
    deliveryUnknown: false,
    retryable: false,
    providerOperationId: providerOperationId || null,
    providerRef,
    publishedUrl,
    reason: null,
    code: null,
  };
}

/**
 * Fail-closed контракт адаптера. Адаптер без reconcile не допускается к публикации:
 * при обрыве сети статья не должна выйти дважды.
 */
export function assertSiteDestinationAdapter(adapter) {
  if (!adapter || !isSiteDestinationKind(adapter.id)) throw new Error("site_adapter_kind_invalid");
  for (const method of ["verify", "publish", "reconcile", "update", "unpublish"]) {
    if (typeof adapter[method] !== "function") throw new Error(`site_adapter_${method}_required`);
  }
  if (adapter.retryPolicy !== "reconcile_before_retry") throw new Error("site_adapter_retry_policy_invalid");
  return true;
}

/** Идентификатор операции у провайдера — slug статьи: он же ключ reconcile. */
export function providerOperationIdFor(article) {
  const slug = String(article?.slug || "").trim();
  if (!slug) throw new TypeError("site_article_slug_required");
  return slug;
}
