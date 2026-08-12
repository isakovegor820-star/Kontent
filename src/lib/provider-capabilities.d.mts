export type ProviderId = "tg" | "vk" | "rss" | "youtube" | "instagram" | "tenchat";
export type ProviderOperation =
  | "livePublish"
  | "exportPackage"
  | "firstComment"
  | "pin"
  | "commentToggle"
  | "analytics";
export type ProviderMediaType = "text" | "image" | "video" | "carousel";
export type ProviderSupportState = "supported" | "unsupported" | "official_access_required";
export type ProviderCredentialState =
  | "not_required"
  | "ready"
  | "not_configured"
  | "expired"
  | "revoked"
  | "invalid"
  | "unknown";
export type ProviderPermissionState = "not_required" | "ready" | "missing" | "denied" | "unknown";
export type ProviderReadinessState =
  | "ready"
  | "unsupported"
  | "official_access_required"
  | "credential_not_configured"
  | "credential_invalid"
  | "credential_unknown"
  | "permission_missing"
  | "permission_denied"
  | "permission_unknown";

export interface ProviderOperationCapability {
  readonly state: ProviderSupportState;
  readonly reason: string | null;
  readonly message: string | null;
  readonly requiresCredentials: boolean;
  readonly requiresPermissions: boolean;
}

export interface ProviderCapability {
  readonly id: ProviderId;
  readonly label: string;
  readonly role: "destination" | "source";
  readonly connection: {
    readonly kind: "bot_token" | "access_token" | "public_url" | "oauth2" | "official_access";
    readonly officialAccessRequired: boolean;
  };
  readonly capabilities: Readonly<Record<ProviderOperation, ProviderOperationCapability>>;
  readonly mediaTypes: readonly ProviderMediaType[];
  readonly limits: {
    readonly textChars: number | null;
    readonly captionChars: number | null;
    readonly titleChars: number | null;
    readonly descriptionBytes: number | null;
    readonly mediaPerPost: number | null;
    readonly authority: "provider" | "product" | "not_applicable" | "unverified";
    readonly source: string | null;
  };
  readonly officialAccess?: {
    readonly verified: boolean;
    readonly checkedAt: string;
    readonly contactUrl: string;
    readonly rulesUrl: string;
    readonly note: string;
  };
}

export interface ProviderReadinessInput {
  credentialState?: ProviderCredentialState;
  permissionState?: ProviderPermissionState;
}

export interface ProviderOperationReadiness {
  readonly available: boolean;
  readonly providerId: ProviderId | null;
  readonly operation: ProviderOperation | null;
  readonly state: ProviderReadinessState;
  readonly reason: string | null;
  readonly message: string | null;
}

export const PROVIDER_IDS: readonly ProviderId[];
export const PROVIDER_OPERATIONS: readonly ProviderOperation[];
export const PROVIDER_MEDIA_TYPES: readonly ProviderMediaType[];
export const PROVIDER_SUPPORT_STATES: Readonly<{
  SUPPORTED: "supported";
  UNSUPPORTED: "unsupported";
  OFFICIAL_ACCESS_REQUIRED: "official_access_required";
}>;
export const PROVIDER_CREDENTIAL_STATES: Readonly<{
  NOT_REQUIRED: "not_required";
  READY: "ready";
  NOT_CONFIGURED: "not_configured";
  EXPIRED: "expired";
  REVOKED: "revoked";
  INVALID: "invalid";
  UNKNOWN: "unknown";
}>;
export const PROVIDER_PERMISSION_STATES: Readonly<{
  NOT_REQUIRED: "not_required";
  READY: "ready";
  MISSING: "missing";
  DENIED: "denied";
  UNKNOWN: "unknown";
}>;
export const PROVIDER_READINESS_STATES: Readonly<{
  READY: "ready";
  UNSUPPORTED: "unsupported";
  OFFICIAL_ACCESS_REQUIRED: "official_access_required";
  CREDENTIAL_NOT_CONFIGURED: "credential_not_configured";
  CREDENTIAL_INVALID: "credential_invalid";
  CREDENTIAL_UNKNOWN: "credential_unknown";
  PERMISSION_MISSING: "permission_missing";
  PERMISSION_DENIED: "permission_denied";
  PERMISSION_UNKNOWN: "permission_unknown";
}>;

export const PROVIDER_CAPABILITY_REGISTRY: Readonly<Record<ProviderId, ProviderCapability>>;

export function normalizeProviderId(value: unknown): ProviderId | null;
export function getProviderCapability(value: unknown): ProviderCapability | null;
export function providerSupportsOperation(providerId: unknown, operation: unknown): boolean;
export function providerSupportsMediaType(providerId: unknown, mediaType: unknown): boolean;
export function resolveProviderOperation(
  providerId: unknown,
  operation: unknown,
  readiness?: ProviderReadinessInput,
): ProviderOperationReadiness;

export class ProviderCapabilityError extends Error {
  readonly code: "provider_operation_unavailable";
  readonly readiness: ProviderOperationReadiness;
}

export function assertProviderOperationAvailable(
  providerId: unknown,
  operation: unknown,
  readiness?: ProviderReadinessInput,
): ProviderOperationReadiness;
export function providerCapabilityCatalog(): readonly ProviderCapability[];
