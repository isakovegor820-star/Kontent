export type TenChatConfigurationState =
  | "not_supplied"
  | "invalid"
  | "adapter_implementation_required";

export interface TenChatServerConfig {
  readonly apiBaseUrl: string;
  readonly grantId: string;
  readonly accessToken: string;
}

export interface TenChatIntegrationReadiness {
  readonly providerId: "tenchat";
  readonly label: "TenChat";
  readonly mode: "export_only";
  readonly livePublish: {
    readonly available: false;
    readonly state: "official_access_required";
    readonly reason: "official_access_required";
    readonly code: "tenchat_official_access_required";
    readonly terminal: true;
    readonly retryable: false;
    readonly message: string;
  };
  readonly exportPackage: {
    readonly available: true;
    readonly state: "ready";
    readonly manualPublishRequired: true;
  };
  readonly configuration: {
    readonly state: TenChatConfigurationState;
    readonly configuredForImplementation: boolean;
    readonly error: string | null;
    readonly missingKeys: readonly string[];
    readonly secretsExposed: false;
  };
  readonly officialAccess: {
    readonly verified: false;
    readonly checkedAt: string;
    readonly contactUrl: string;
    readonly rulesUrl: string;
  };
}

export const TENCHAT_OFFICIAL_CONTACT_URL: string;
export const TENCHAT_OFFICIAL_RULES_URL: string;
export const TENCHAT_OFFICIAL_SOURCE_CHECKED_AT: string;

export class TenChatConfigurationError extends Error {
  readonly code: string;
  readonly missingKeys: readonly string[];
}

export function readTenChatServerConfig(
  env?: Record<string, string | undefined>,
): TenChatServerConfig | null;
export function tenChatIntegrationReadiness(
  env?: Record<string, string | undefined>,
): TenChatIntegrationReadiness;
