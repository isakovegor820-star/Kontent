/**
 * Provider capability registry shared by Next.js routes/components and worker.mjs.
 *
 * This file deliberately contains only static, public product facts. It never reads
 * credentials and never makes a provider available merely because a token exists.
 * Dynamic credential and permission checks are applied by resolveProviderOperation().
 */

export const PROVIDER_IDS = Object.freeze([
  "tg",
  "vk",
  "rss",
  "youtube",
  "instagram",
  "tenchat",
]);

export const PROVIDER_OPERATIONS = Object.freeze([
  "livePublish",
  "exportPackage",
  "firstComment",
  "pin",
  "commentToggle",
  "analytics",
]);

export const PROVIDER_MEDIA_TYPES = Object.freeze([
  "text",
  "image",
  "video",
  "carousel",
]);

export const PROVIDER_SUPPORT_STATES = Object.freeze({
  SUPPORTED: "supported",
  UNSUPPORTED: "unsupported",
  OFFICIAL_ACCESS_REQUIRED: "official_access_required",
});

export const PROVIDER_CREDENTIAL_STATES = Object.freeze({
  NOT_REQUIRED: "not_required",
  READY: "ready",
  NOT_CONFIGURED: "not_configured",
  EXPIRED: "expired",
  REVOKED: "revoked",
  INVALID: "invalid",
  UNKNOWN: "unknown",
});

export const PROVIDER_PERMISSION_STATES = Object.freeze({
  NOT_REQUIRED: "not_required",
  READY: "ready",
  MISSING: "missing",
  DENIED: "denied",
  UNKNOWN: "unknown",
});

export const PROVIDER_READINESS_STATES = Object.freeze({
  READY: "ready",
  UNSUPPORTED: "unsupported",
  OFFICIAL_ACCESS_REQUIRED: "official_access_required",
  CREDENTIAL_NOT_CONFIGURED: "credential_not_configured",
  CREDENTIAL_INVALID: "credential_invalid",
  CREDENTIAL_UNKNOWN: "credential_unknown",
  PERMISSION_MISSING: "permission_missing",
  PERMISSION_DENIED: "permission_denied",
  PERMISSION_UNKNOWN: "permission_unknown",
});

const TELEGRAM_BOT_API = "https://core.telegram.org/bots/api";
const VK_API_SCHEMA = "https://github.com/VKCOM/vk-api-schema";
const YOUTUBE_API = "https://developers.google.com/youtube/v3/docs/videos";
const INSTAGRAM_API = "https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api";
const TENCHAT_PARTNER_CONTACT = "https://tenchat.ru/contacts";
const TENCHAT_RULES =
  "https://cdn1.tenchat.ru/static/vbc-gostinder/document/921e5418-d917-4e97-bb89-e296418e2a30.pdf";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function supported({ credentials = false, permissions = false } = {}) {
  return {
    state: PROVIDER_SUPPORT_STATES.SUPPORTED,
    reason: null,
    message: null,
    requiresCredentials: credentials,
    requiresPermissions: permissions,
  };
}

function unsupported(reason, message) {
  return {
    state: PROVIDER_SUPPORT_STATES.UNSUPPORTED,
    reason,
    message,
    requiresCredentials: false,
    requiresPermissions: false,
  };
}

function officialAccessRequired(message) {
  return {
    state: PROVIDER_SUPPORT_STATES.OFFICIAL_ACCESS_REQUIRED,
    reason: "official_access_required",
    message,
    requiresCredentials: true,
    requiresPermissions: true,
  };
}

const NOT_IMPLEMENTED = "Эта операция пока не поддерживается Авророй для выбранной площадки.";
const SOURCE_ONLY = "RSS используется как источник материалов, а не как площадка публикации.";
const COMPOSER_UNSUPPORTED = "Публикация станет доступна после поддержки формата площадки в Композиторе.";
const TENCHAT_OFFICIAL_ACCESS =
  "Для автопубликации в TenChat нужен подтверждённый официальный доступ. Сейчас доступен экспорт пакета публикации.";

/**
 * Static product support. A `supported` entry means Aurora has an end-to-end path;
 * credential and permission readiness must still be proven at request/job time.
 */
export const PROVIDER_CAPABILITY_REGISTRY = deepFreeze({
  tg: {
    id: "tg",
    label: "Telegram",
    role: "destination",
    connection: { kind: "bot_token", officialAccessRequired: false },
    capabilities: {
      livePublish: supported({ credentials: true, permissions: true }),
      exportPackage: unsupported("export_package_not_implemented", NOT_IMPLEMENTED),
      firstComment: supported({ credentials: true, permissions: true }),
      pin: supported({ credentials: true, permissions: true }),
      commentToggle: unsupported("comment_toggle_not_implemented", NOT_IMPLEMENTED),
      analytics: supported({ credentials: true, permissions: true }),
    },
    mediaTypes: ["text", "image", "video", "carousel"],
    limits: {
      textChars: 4096,
      captionChars: 1024,
      titleChars: null,
      descriptionBytes: null,
      mediaPerPost: 10,
      authority: "provider",
      source: TELEGRAM_BOT_API,
    },
  },
  vk: {
    id: "vk",
    label: "VK",
    role: "destination",
    connection: { kind: "access_token", officialAccessRequired: false },
    capabilities: {
      livePublish: supported({ credentials: true, permissions: true }),
      exportPackage: unsupported("export_package_not_implemented", NOT_IMPLEMENTED),
      firstComment: supported({ credentials: true, permissions: true }),
      pin: unsupported("pin_not_implemented", NOT_IMPLEMENTED),
      commentToggle: supported({ credentials: true, permissions: true }),
      analytics: supported({ credentials: true, permissions: true }),
    },
    // The current worker publishes wall text only. Media stays closed until the
    // attachment upload path is implemented and contract-tested.
    mediaTypes: ["text"],
    limits: {
      textChars: 15_000,
      captionChars: null,
      titleChars: null,
      descriptionBytes: null,
      mediaPerPost: 0,
      authority: "product",
      source: VK_API_SCHEMA,
    },
  },
  rss: {
    id: "rss",
    label: "RSS",
    role: "source",
    connection: { kind: "public_url", officialAccessRequired: false },
    capabilities: {
      livePublish: unsupported("source_only", SOURCE_ONLY),
      exportPackage: unsupported("source_only", SOURCE_ONLY),
      firstComment: unsupported("source_only", SOURCE_ONLY),
      pin: unsupported("source_only", SOURCE_ONLY),
      commentToggle: unsupported("source_only", SOURCE_ONLY),
      analytics: unsupported("source_only", SOURCE_ONLY),
    },
    mediaTypes: [],
    limits: {
      textChars: null,
      captionChars: null,
      titleChars: null,
      descriptionBytes: null,
      mediaPerPost: null,
      authority: "not_applicable",
      source: null,
    },
  },
  youtube: {
    id: "youtube",
    label: "YouTube",
    role: "destination",
    connection: { kind: "oauth2", officialAccessRequired: false },
    capabilities: {
      livePublish: unsupported("composer_payload_unsupported", COMPOSER_UNSUPPORTED),
      exportPackage: unsupported("export_package_not_implemented", NOT_IMPLEMENTED),
      firstComment: unsupported("first_comment_not_implemented", NOT_IMPLEMENTED),
      pin: unsupported("pin_not_implemented", NOT_IMPLEMENTED),
      commentToggle: unsupported("comment_toggle_not_implemented", NOT_IMPLEMENTED),
      analytics: unsupported("analytics_not_implemented", NOT_IMPLEMENTED),
    },
    mediaTypes: ["video"],
    limits: {
      textChars: null,
      captionChars: null,
      titleChars: 100,
      descriptionBytes: 5000,
      mediaPerPost: 1,
      authority: "provider",
      source: YOUTUBE_API,
    },
  },
  instagram: {
    id: "instagram",
    label: "Instagram",
    role: "destination",
    connection: { kind: "oauth2", officialAccessRequired: false },
    capabilities: {
      livePublish: unsupported("composer_payload_unsupported", COMPOSER_UNSUPPORTED),
      exportPackage: unsupported("export_package_not_implemented", NOT_IMPLEMENTED),
      firstComment: unsupported("first_comment_not_implemented", NOT_IMPLEMENTED),
      pin: unsupported("pin_not_implemented", NOT_IMPLEMENTED),
      commentToggle: unsupported("comment_toggle_not_implemented", NOT_IMPLEMENTED),
      analytics: unsupported("analytics_not_implemented", NOT_IMPLEMENTED),
    },
    mediaTypes: ["image", "video"],
    limits: {
      textChars: 2200,
      captionChars: 2200,
      titleChars: null,
      descriptionBytes: null,
      mediaPerPost: 1,
      authority: "provider",
      source: INSTAGRAM_API,
    },
  },
  tenchat: {
    id: "tenchat",
    label: "TenChat",
    role: "destination",
    connection: { kind: "official_access", officialAccessRequired: true },
    capabilities: {
      livePublish: officialAccessRequired(TENCHAT_OFFICIAL_ACCESS),
      exportPackage: supported(),
      firstComment: unsupported("official_capability_unverified", NOT_IMPLEMENTED),
      pin: unsupported("official_capability_unverified", NOT_IMPLEMENTED),
      commentToggle: unsupported("official_capability_unverified", NOT_IMPLEMENTED),
      analytics: officialAccessRequired(TENCHAT_OFFICIAL_ACCESS),
    },
    // These are Aurora export-package asset types, not an undocumented TenChat API claim.
    mediaTypes: ["text", "image", "carousel"],
    limits: {
      textChars: null,
      captionChars: null,
      titleChars: null,
      descriptionBytes: null,
      mediaPerPost: null,
      authority: "unverified",
      source: TENCHAT_PARTNER_CONTACT,
    },
    officialAccess: {
      verified: false,
      checkedAt: "2026-08-12",
      contactUrl: TENCHAT_PARTNER_CONTACT,
      rulesUrl: TENCHAT_RULES,
      note: TENCHAT_OFFICIAL_ACCESS,
    },
  },
});

const PROVIDER_CAPABILITY_CATALOG = Object.freeze(
  PROVIDER_IDS.map((id) => PROVIDER_CAPABILITY_REGISTRY[id]),
);

const PROVIDER_ALIASES = Object.freeze({ telegram: "tg" });

export function normalizeProviderId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const canonical = PROVIDER_ALIASES[normalized] || normalized;
  return Object.hasOwn(PROVIDER_CAPABILITY_REGISTRY, canonical) ? canonical : null;
}

export function getProviderCapability(value) {
  const id = normalizeProviderId(value);
  return id ? PROVIDER_CAPABILITY_REGISTRY[id] : null;
}

function normalizeOperation(value) {
  return PROVIDER_OPERATIONS.includes(value) ? value : null;
}

export function providerSupportsOperation(providerId, operation) {
  const provider = getProviderCapability(providerId);
  const normalizedOperation = normalizeOperation(operation);
  return Boolean(
    provider
      && normalizedOperation
      && provider.capabilities[normalizedOperation]?.state === PROVIDER_SUPPORT_STATES.SUPPORTED,
  );
}

export function providerSupportsMediaType(providerId, mediaType) {
  const provider = getProviderCapability(providerId);
  return Boolean(provider && PROVIDER_MEDIA_TYPES.includes(mediaType) && provider.mediaTypes.includes(mediaType));
}

function unavailable(providerId, operation, state, reason, message) {
  return {
    available: false,
    providerId,
    operation,
    state,
    reason,
    message,
  };
}

/**
 * Resolve one operation with live readiness supplied by the authenticated server path.
 * Missing/unknown readiness is denied by default; callers must prove readiness.
 */
export function resolveProviderOperation(providerValue, operationValue, readiness = {}) {
  const provider = getProviderCapability(providerValue);
  if (!provider) {
    return unavailable(
      null,
      null,
      PROVIDER_READINESS_STATES.UNSUPPORTED,
      "unknown_provider",
      "Провайдер не поддерживается.",
    );
  }

  const operation = normalizeOperation(operationValue);
  if (!operation) {
    return unavailable(
      provider.id,
      null,
      PROVIDER_READINESS_STATES.UNSUPPORTED,
      "unknown_operation",
      "Операция провайдера не поддерживается.",
    );
  }

  const capability = provider.capabilities[operation];
  if (capability.state === PROVIDER_SUPPORT_STATES.OFFICIAL_ACCESS_REQUIRED) {
    return unavailable(
      provider.id,
      operation,
      PROVIDER_READINESS_STATES.OFFICIAL_ACCESS_REQUIRED,
      capability.reason,
      capability.message,
    );
  }
  if (capability.state !== PROVIDER_SUPPORT_STATES.SUPPORTED) {
    return unavailable(
      provider.id,
      operation,
      PROVIDER_READINESS_STATES.UNSUPPORTED,
      capability.reason,
      capability.message,
    );
  }

  if (capability.requiresCredentials) {
    const state = readiness.credentialState || PROVIDER_CREDENTIAL_STATES.UNKNOWN;
    if (state === PROVIDER_CREDENTIAL_STATES.NOT_CONFIGURED) {
      return unavailable(provider.id, operation, PROVIDER_READINESS_STATES.CREDENTIAL_NOT_CONFIGURED, state,
        "Подключение площадки не настроено.");
    }
    if ([
      PROVIDER_CREDENTIAL_STATES.EXPIRED,
      PROVIDER_CREDENTIAL_STATES.REVOKED,
      PROVIDER_CREDENTIAL_STATES.INVALID,
    ].includes(state)) {
      return unavailable(provider.id, operation, PROVIDER_READINESS_STATES.CREDENTIAL_INVALID, state,
        "Подключение площадки нужно обновить.");
    }
    if (state !== PROVIDER_CREDENTIAL_STATES.READY) {
      return unavailable(provider.id, operation, PROVIDER_READINESS_STATES.CREDENTIAL_UNKNOWN, state,
        "Готовность подключения не подтверждена.");
    }
  }

  if (capability.requiresPermissions) {
    const state = readiness.permissionState || PROVIDER_PERMISSION_STATES.UNKNOWN;
    if (state === PROVIDER_PERMISSION_STATES.MISSING) {
      return unavailable(provider.id, operation, PROVIDER_READINESS_STATES.PERMISSION_MISSING, state,
        "Для операции не хватает разрешения площадки.");
    }
    if (state === PROVIDER_PERMISSION_STATES.DENIED) {
      return unavailable(provider.id, operation, PROVIDER_READINESS_STATES.PERMISSION_DENIED, state,
        "Площадка запретила эту операцию.");
    }
    if (state !== PROVIDER_PERMISSION_STATES.READY) {
      return unavailable(provider.id, operation, PROVIDER_READINESS_STATES.PERMISSION_UNKNOWN, state,
        "Разрешение площадки не подтверждено.");
    }
  }

  return {
    available: true,
    providerId: provider.id,
    operation,
    state: PROVIDER_READINESS_STATES.READY,
    reason: null,
    message: null,
  };
}

export class ProviderCapabilityError extends Error {
  constructor(readiness) {
    super(readiness?.message || "Операция провайдера недоступна.");
    this.name = "ProviderCapabilityError";
    this.code = "provider_operation_unavailable";
    this.readiness = readiness;
  }
}

export function assertProviderOperationAvailable(providerId, operation, readiness) {
  const result = resolveProviderOperation(providerId, operation, readiness);
  if (!result.available) throw new ProviderCapabilityError(result);
  return result;
}

/** JSON-safe, immutable catalog suitable for a UI/API response. */
export function providerCapabilityCatalog() {
  return PROVIDER_CAPABILITY_CATALOG;
}
