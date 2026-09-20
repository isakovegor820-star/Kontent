export const SITE_DESTINATION_KINDS: readonly ["wordpress", "site_hosted"];
export const SITE_ARTICLE_ACTIONS: readonly ["publish", "update", "unpublish"];
export type SiteDestinationKind = "wordpress" | "site_hosted";
export const SITE_DESTINATION_CAPABILITIES: Readonly<Record<SiteDestinationKind, Readonly<Record<string, unknown>>>>;
export const PROVIDER_DELIVERY_OUTCOMES: Readonly<{
  SUCCESS: "success";
  DEFINITE_FAILURE: "definite_failure";
  DELIVERY_UNKNOWN: "delivery_unknown";
  RATE_LIMITED: "rate_limited";
  AUTH_FAILED: "auth_failed";
}>;

export type SiteDeliveryResult = {
  ok: boolean;
  outcome: "success" | "definite_failure" | "delivery_unknown" | "rate_limited" | "auth_failed";
  deliveryUnknown: boolean;
  retryable: boolean;
  providerOperationId: string | null;
  providerRef?: Record<string, unknown> | null;
  publishedUrl?: string | null;
  reason: string | null;
  code?: string | null;
};

export type SiteDestinationVerification = {
  ok: boolean;
  credentialState: string;
  permissionState: string;
  reason: string | null;
  account?: { id: number; name: string };
  origin?: string;
  checkedAt?: string;
};

export type SiteArticlePayload = {
  slug: string;
  title: string;
  metaDescription?: string | null;
  bodyHtml: string;
  structuredData?: Record<string, unknown> | null;
  publishAt?: string | null;
  categoryId?: number | null;
};

export type SiteDestinationRuntime = {
  id: number;
  kind: SiteDestinationKind;
  baseUrl: string;
  sectionPath: string | null;
  settings: Record<string, unknown> & { hostedSlug: string | null };
  credentials: Record<string, unknown> | null;
};

export type SiteDestinationAdapter = {
  id: SiteDestinationKind;
  composerSupported: boolean;
  retryPolicy: "reconcile_before_retry";
  verify(destination: SiteDestinationRuntime): Promise<SiteDestinationVerification>;
  publish(destination: SiteDestinationRuntime, payload: SiteArticlePayload): Promise<SiteDeliveryResult>;
  reconcile(destination: SiteDestinationRuntime, providerOperationId: string): Promise<SiteDeliveryResult>;
  update(destination: SiteDestinationRuntime, providerRef: Record<string, unknown> | null, payload: SiteArticlePayload): Promise<SiteDeliveryResult>;
  unpublish(destination: SiteDestinationRuntime, providerRef: Record<string, unknown> | null): Promise<SiteDeliveryResult>;
};

export function isSiteDestinationKind(value: unknown): value is SiteDestinationKind;
export function assertSiteDestinationAdapter(adapter: unknown): true;
export function providerOperationIdFor(article: { slug: string }): string;
export function success(providerOperationId: string | null, extra?: { providerRef?: unknown; publishedUrl?: string | null }): SiteDeliveryResult;
export function definiteFailure(reason: string, extra?: Record<string, unknown>): SiteDeliveryResult;
export function deliveryUnknown(providerOperationId: string | null, reason?: string): SiteDeliveryResult;
export function classifiedFailure(outcome: string, reason: string, extra?: Record<string, unknown>): SiteDeliveryResult;

export function hostedSitesDomain(env?: Record<string, string | undefined>): string | null;
export function hostedSectionOrigin(slug: string | null | undefined, env?: Record<string, string | undefined>): string | null;
export function hostedArticleUrl(slug: string | null | undefined, articleSlug: string, env?: Record<string, string | undefined>): string | null;
export function hostedSlugFromHost(hostHeader: string | null | undefined, env?: Record<string, string | undefined>): string | null;
export function deriveHostedSlug(confirmedDomain: string): string | null;
export function createHostedAdapter(options?: { env?: Record<string, string | undefined> }): SiteDestinationAdapter;

export class WordPressAdapterError extends Error {
  code: string;
  status: number | null;
}
export function wpPostToRef(post: unknown, baseUrl?: string): Record<string, unknown> | null;
export function createWordPressAdapter(options?: {
  fetchImpl?: typeof fetch;
  lookupFn?: (hostname: string, options: unknown) => Promise<Array<{ address: string; family: number }>>;
  timeoutMs?: number;
  now?: () => Date;
}): SiteDestinationAdapter;

export function encryptDestinationCredentials(credentials: Record<string, unknown>, ctx: { userId: number }): string;
export function decryptDestinationCredentials(envelope: string | null, ctx: { userId: number }): Record<string, unknown> | null;
export function normalizeWordPressCredentials(input: unknown): { username: string; appPassword: string } | null;
export function createSiteDestinationAdapters(options?: Record<string, unknown>): Readonly<Record<SiteDestinationKind, SiteDestinationAdapter>>;
export function destinationRuntime(
  row: { id: number | string; kind: SiteDestinationKind; base_url: string; section_path?: string | null; settings?: Record<string, unknown> | null; credentials?: string | null },
  ctx: { userId: number; hostedSlug?: string | null },
): SiteDestinationRuntime;
