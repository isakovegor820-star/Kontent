import { createHash } from "node:crypto";

import { normalizeIdempotencyKey } from "./publication-idempotency";
import type {
  LegalDataType,
  LegalProviderKind,
  LegalProviderOperation,
  LegalSubscriptionStatus,
} from "./legal-provider-adapter.mjs";

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const FORBIDDEN_CREDENTIAL_FIELD = /(?:password|passcode|cookie|session(?:id)?)/i;
const MAX_TOKEN_LENGTH = 16_384;

export type LegalConnectionStatus = "connected" | "invalid" | "expired" | "disconnected";

export type LegalConnectionRow = {
  id: string | number;
  provider_id: string;
  provider_label: string;
  integration_kind: LegalProviderKind;
  status: LegalConnectionStatus;
  subscription_status: LegalSubscriptionStatus;
  external_account_label: string | null;
  token_expires_at: Date | string | null;
  last_sync_at: Date | string | null;
  last_health_at: Date | string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export type LegalConnectInput = {
  requestKey: string;
  providerId: string;
  token: string;
};

export type LegalAction = Extract<LegalProviderOperation, "validate" | "sync" | "health" | "disconnect">;

export type LegalActionInput = {
  requestKey: string;
  action: LegalAction;
};

export type LegalInputResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error:
        | "bad_request"
        | "forbidden_credential_field"
        | "idempotency_key_required"
        | "bad_provider"
        | "token_required"
        | "bad_action";
    };

function ownEntries(value: object) {
  return Object.entries(value as Record<string, unknown>);
}

/** Reject credentials that Aurora must never collect, including nested payloads. */
export function findForbiddenLegalCredentialField(value: unknown): string | null {
  const seen = new Set<object>();
  function visit(node: unknown, path: string): string | null {
    if (!node || typeof node !== "object") return null;
    if (seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        const found = visit(node[index], `${path}[${index}]`);
        if (found) return found;
      }
      return null;
    }
    for (const [key, child] of ownEntries(node)) {
      if (FORBIDDEN_CREDENTIAL_FIELD.test(key)) return path ? `${path}.${key}` : key;
      const found = visit(child, path ? `${path}.${key}` : key);
      if (found) return found;
    }
    return null;
  }
  return visit(value, "");
}

function requestKey(raw: Record<string, unknown>, header: string | null | undefined): string | null {
  const body = typeof raw.requestKey === "string" ? raw.requestKey : null;
  if (header && body && header !== body) return null;
  return normalizeIdempotencyKey(header || body);
}

export function parseLegalConnectInput(raw: unknown, headerKey?: string | null): LegalInputResult<LegalConnectInput> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "bad_request" };
  const forbidden = findForbiddenLegalCredentialField(raw);
  if (forbidden) return { ok: false, error: "forbidden_credential_field" };
  const input = raw as Record<string, unknown>;
  const key = requestKey(input, headerKey);
  if (!key) return { ok: false, error: "idempotency_key_required" };
  const providerId = String(input.providerId ?? "").trim().toLowerCase();
  if (!PROVIDER_ID.test(providerId)) return { ok: false, error: "bad_provider" };
  const token = typeof input.token === "string" ? input.token.trim() : "";
  if (!token || token.length > MAX_TOKEN_LENGTH) return { ok: false, error: "token_required" };
  return { ok: true, value: { requestKey: key, providerId, token } };
}

export function parseLegalActionInput(raw: unknown, headerKey?: string | null): LegalInputResult<LegalActionInput> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "bad_request" };
  const forbidden = findForbiddenLegalCredentialField(raw);
  if (forbidden) return { ok: false, error: "forbidden_credential_field" };
  const input = raw as Record<string, unknown>;
  const key = requestKey(input, headerKey);
  if (!key) return { ok: false, error: "idempotency_key_required" };
  const action = String(input.action ?? "").trim().toLowerCase();
  if (action !== "validate" && action !== "sync" && action !== "health" && action !== "disconnect") {
    return { ok: false, error: "bad_action" };
  }
  return { ok: true, value: { requestKey: key, action } };
}

export function legalOperationFingerprint(input: {
  operation: LegalProviderOperation;
  providerId: string;
  connectionId?: number | null;
  token?: string | null;
}): string {
  const tokenDigest = input.token
    ? createHash("sha256").update(input.token, "utf8").digest("hex")
    : null;
  return createHash("sha256")
    .update(JSON.stringify([input.operation, input.providerId, input.connectionId ?? null, tokenDigest]), "utf8")
    .digest("hex");
}

function toIso(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function serializeLegalConnection(row: LegalConnectionRow) {
  return {
    id: Number(row.id),
    providerId: row.provider_id,
    providerLabel: row.provider_label,
    kind: row.integration_kind,
    status: row.status,
    subscriptionStatus: row.subscription_status,
    accountLabel: row.external_account_label,
    tokenExpiresAt: toIso(row.token_expires_at),
    lastSyncAt: toIso(row.last_sync_at),
    lastHealthAt: toIso(row.last_health_at),
    lastError: row.last_error_code
      ? { code: row.last_error_code, message: row.last_error_message || "Интеграция требует проверки." }
      : null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function legalTypeLabel(type: LegalDataType): string {
  return ({
    law: "Нормативный акт",
    case: "Судебное дело",
    commentary: "Комментарий",
    document: "Документ",
  } satisfies Record<LegalDataType, string>)[type];
}

export function safeLegalError(error: unknown): { code: string; retryable: boolean; status: number } {
  const value = error as { code?: unknown; retryable?: unknown; status?: unknown };
  const code = typeof value?.code === "string" ? value.code.slice(0, 80) : "provider_unavailable";
  const retryable = value?.retryable === true;
  const status = Number.isInteger(value?.status)
    ? Number(value.status)
    : code === "provider_rate_limited"
      ? 429
      : code === "provider_credentials_rejected" || code === "subscription_inactive"
        ? 422
        : 503;
  return { code, retryable, status };
}
