export type LegalProviderKind =
  | "official_api"
  | "vendor_export"
  | "user_file"
  | "licensed_integration";
export type LegalDataType = "law" | "case" | "commentary" | "document";
export type LegalCurrentness = "current" | "superseded" | "unknown";
export type LegalSubscriptionStatus = "active" | "trial" | "expired" | "inactive" | "unknown";
export type LegalProviderOperation = "connect" | "validate" | "sync" | "health" | "disconnect";

export type LegalProviderConfig = Readonly<{
  id: string;
  label: string;
  kind: LegalProviderKind;
  baseUrl: string;
  endpoints: Readonly<Partial<Record<LegalProviderOperation, string>>>;
  idempotencyHeader: string;
  licenseNotice: string;
  subscriptionRequired: boolean;
}>;

export type LegalFragment = {
  fragmentIndex: number;
  text: string;
  sourceName: string;
  sourceDate: string;
  currentness: LegalCurrentness;
  sourceUrl: string;
};

export type LegalRecord = {
  externalId: string;
  legalType: LegalDataType;
  title: string;
  sourceName: string;
  sourceDate: string;
  currentness: LegalCurrentness;
  sourceUrl: string;
  relevantAt: string | null;
  fragments: LegalFragment[];
};

export class LegalProviderError extends Error {
  code: string;
  retryable: boolean;
  status: number | null;
  constructor(code: string, message: string, options?: { retryable?: boolean; status?: number });
}

export function normalizeLegalProviderConfig(raw: unknown): LegalProviderConfig;
export function loadLegalProviderRegistry(serialized?: string): readonly LegalProviderConfig[];
export function publicLegalProvider(provider: LegalProviderConfig): {
  id: string;
  label: string;
  kind: LegalProviderKind;
  licenseNotice: string | null;
  subscriptionRequired: boolean;
  capabilities: LegalProviderOperation[];
};
export function getLegalProvider(providerId: unknown, registry?: readonly LegalProviderConfig[]): LegalProviderConfig;
export function normalizeLegalFragments(records: unknown): LegalRecord[];
export function createLegalProviderAdapter(
  provider: LegalProviderConfig,
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Readonly<{
  connect(input: { token?: string; idempotencyKey: string }): Promise<{
    accountLabel: string | null;
    subscriptionStatus: LegalSubscriptionStatus;
    tokenExpiresAt: string | null;
  }>;
  validate(input: { token?: string; idempotencyKey: string }): Promise<{
    valid: boolean;
    subscriptionStatus: LegalSubscriptionStatus;
    tokenExpiresAt: string | null;
  }>;
  sync(input: { token?: string; cursor?: string | null; idempotencyKey: string }): Promise<{
    cursor: string | null;
    fragments: LegalRecord[];
  }>;
  health(input: { token?: string; idempotencyKey: string }): Promise<{
    healthy: boolean;
    subscriptionStatus: LegalSubscriptionStatus;
    tokenExpiresAt: string | null;
    message: string | null;
  }>;
  disconnect(input: { token?: string; idempotencyKey: string }): Promise<{ disconnected: true }>;
}>;
export const LEGAL_PROVIDER_KINDS: readonly LegalProviderKind[];
export const LEGAL_DATA_TYPES: readonly LegalDataType[];
