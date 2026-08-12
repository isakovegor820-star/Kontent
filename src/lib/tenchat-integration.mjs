/**
 * Server-only configuration boundary for a future official TenChat integration.
 *
 * Environment variables can prove that an operator supplied a written-access
 * reference and credentials. They cannot enable live publishing by themselves:
 * the adapter remains fail-closed until an authorized API contract is implemented
 * and covered by provider contract tests.
 */

export const TENCHAT_OFFICIAL_CONTACT_URL = "https://tenchat.ru/contacts";
export const TENCHAT_OFFICIAL_RULES_URL =
  "https://cdn1.tenchat.ru/static/vbc-gostinder/document/921e5418-d917-4e97-bb89-e296418e2a30.pdf";
export const TENCHAT_OFFICIAL_SOURCE_CHECKED_AT = "2026-08-12";

const REQUIRED_CONFIG_KEYS = Object.freeze([
  "TENCHAT_OFFICIAL_ACCESS_MODE",
  "TENCHAT_OFFICIAL_ACCESS_GRANT_ID",
  "TENCHAT_OFFICIAL_API_BASE_URL",
  "TENCHAT_OFFICIAL_API_TOKEN",
]);

export class TenChatConfigurationError extends Error {
  constructor(code, missingKeys = []) {
    super(code);
    this.name = "TenChatConfigurationError";
    this.code = code;
    this.missingKeys = Object.freeze([...missingKeys]);
  }
}

function value(env, key) {
  return String(env?.[key] ?? "").trim();
}

function officialApiBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new TenChatConfigurationError("tenchat_api_base_url_invalid");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || (hostname !== "tenchat.ru" && !hostname.endsWith(".tenchat.ru"))
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new TenChatConfigurationError("tenchat_api_base_url_invalid");
  }
  return url.toString().replace(/\/+$/u, "");
}

/**
 * Reads secrets only on the server. `null` means no official access was supplied.
 * A returned config is readiness for adapter implementation, not permission to publish.
 */
export function readTenChatServerConfig(env = process.env) {
  const supplied = REQUIRED_CONFIG_KEYS.filter((key) => value(env, key));
  if (supplied.length === 0) return null;

  const missing = REQUIRED_CONFIG_KEYS.filter((key) => !value(env, key));
  if (missing.length > 0) {
    throw new TenChatConfigurationError("tenchat_config_incomplete", missing);
  }
  if (value(env, "TENCHAT_OFFICIAL_ACCESS_MODE") !== "written_partner_agreement") {
    throw new TenChatConfigurationError("tenchat_written_access_required");
  }

  const grantId = value(env, "TENCHAT_OFFICIAL_ACCESS_GRANT_ID");
  if (!/^[A-Za-z0-9._:/-]{8,160}$/u.test(grantId)) {
    throw new TenChatConfigurationError("tenchat_grant_id_invalid");
  }

  const accessToken = value(env, "TENCHAT_OFFICIAL_API_TOKEN");
  if (accessToken.length < 32 || accessToken.length > 4096 || /\s|[\p{Cc}\p{Cf}]/u.test(accessToken)) {
    throw new TenChatConfigurationError("tenchat_api_token_invalid");
  }

  return Object.freeze({
    apiBaseUrl: officialApiBaseUrl(value(env, "TENCHAT_OFFICIAL_API_BASE_URL")),
    grantId,
    accessToken,
  });
}

/** JSON-safe readiness for APIs and UI. Secret values are never returned. */
export function tenChatIntegrationReadiness(env = process.env) {
  let configurationState = "not_supplied";
  let configurationError = null;
  let configuredForImplementation = false;
  let missingKeys = [];
  try {
    const config = readTenChatServerConfig(env);
    if (config) {
      configurationState = "adapter_implementation_required";
      configuredForImplementation = true;
    }
  } catch (error) {
    configurationState = "invalid";
    configurationError = error instanceof TenChatConfigurationError
      ? error.code
      : "tenchat_config_invalid";
    missingKeys = error instanceof TenChatConfigurationError ? [...error.missingKeys] : [];
  }

  return Object.freeze({
    providerId: "tenchat",
    label: "TenChat",
    mode: "export_only",
    livePublish: Object.freeze({
      available: false,
      state: "official_access_required",
      reason: "official_access_required",
      code: "tenchat_official_access_required",
      terminal: true,
      retryable: false,
      message: "Для автопубликации нужен подтверждённый официальный доступ TenChat и реализованный контракт адаптера.",
    }),
    exportPackage: Object.freeze({
      available: true,
      state: "ready",
      manualPublishRequired: true,
    }),
    configuration: Object.freeze({
      state: configurationState,
      configuredForImplementation,
      error: configurationError,
      missingKeys: Object.freeze(missingKeys),
      secretsExposed: false,
    }),
    officialAccess: Object.freeze({
      verified: false,
      checkedAt: TENCHAT_OFFICIAL_SOURCE_CHECKED_AT,
      contactUrl: TENCHAT_OFFICIAL_CONTACT_URL,
      rulesUrl: TENCHAT_OFFICIAL_RULES_URL,
    }),
  });
}
