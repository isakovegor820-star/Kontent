import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import {
  createLegalProviderAdapter,
  getLegalProvider,
  LegalProviderError,
  loadLegalProviderRegistry,
  publicLegalProvider,
  type LegalProviderConfig,
  type LegalRecord,
} from "./legal-provider-adapter.mjs";
import { decryptToken, encryptToken } from "./token-crypto.mjs";
import {
  legalOperationFingerprint,
  safeLegalError,
  serializeLegalConnection,
  type LegalAction,
  type LegalConnectionRow,
} from "./legal-sources";

type Queryable = Pick<Pool, "query">;
type LegalPool = Pick<Pool, "query" | "connect">;

type OperationRow = {
  id: string | number;
  request_fingerprint: string;
  status: "dispatching" | "succeeded" | "failed";
  lease_token: string | null;
  lease_expires_at: Date | string | null;
  result_payload: Record<string, unknown> | null;
  http_status: number | null;
};

type StoredConnectionRow = LegalConnectionRow & {
  token_envelope: string | null;
  sync_cursor: string | null;
};

export type LegalServiceResult = {
  status: number;
  body: Record<string, unknown>;
  replayed?: boolean;
};

type ServiceOptions = {
  registry?: readonly LegalProviderConfig[];
  adapterFactory?: typeof createLegalProviderAdapter;
};

const CONNECTION_FIELDS = `id, provider_id, provider_label, integration_kind, status,
  subscription_status, external_account_label, token_expires_at, last_sync_at,
  last_health_at, last_error_code, last_error_message, created_at, updated_at`;
const STORED_CONNECTION_FIELDS = `${CONNECTION_FIELDS}, token_envelope, sync_cursor`;

function registry(options: ServiceOptions): readonly LegalProviderConfig[] {
  return options.registry ?? loadLegalProviderRegistry();
}

function adapter(provider: LegalProviderConfig, options: ServiceOptions) {
  return (options.adapterFactory ?? createLegalProviderAdapter)(provider);
}

function providerContext(providerId: string) {
  return `legal:${providerId}`;
}

function connectionErrorMessage(code: string) {
  switch (code) {
    case "provider_credentials_rejected": return "Провайдер отклонил API-токен.";
    case "subscription_inactive": return "Подписка провайдера неактивна.";
    case "provider_rate_limited": return "Провайдер временно ограничил частоту запросов.";
    case "provider_timeout": return "Провайдер не ответил вовремя.";
    case "not_configured": return "Официальная интеграция не настроена.";
    default: return "Интеграция временно недоступна.";
  }
}

async function reserveOperation(
  pool: Queryable,
  input: {
    userId: number;
    connectionId: number | null;
    providerId: string;
    operation: string;
    requestKey: string;
    fingerprint: string;
  },
): Promise<
  | { kind: "claimed"; id: number; leaseToken: string }
  | { kind: "replay"; status: number; payload: Record<string, unknown> }
  | { kind: "conflict" }
  | { kind: "in_progress" }
> {
  const leaseToken = randomUUID();
  const inserted = await pool.query<OperationRow>(
    `insert into legal_source_operations
       (user_id, connection_id, provider_id, operation, request_key,
        request_fingerprint, lease_token, lease_expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, now() + interval '90 seconds')
     on conflict (user_id, request_key) do nothing
     returning id, request_fingerprint, status, lease_token, lease_expires_at,
               result_payload, http_status`,
    [input.userId, input.connectionId, input.providerId, input.operation, input.requestKey, input.fingerprint, leaseToken],
  );
  if (inserted.rows[0]) {
    return { kind: "claimed", id: Number(inserted.rows[0].id), leaseToken };
  }

  const existing = (
    await pool.query<OperationRow>(
      `select id, request_fingerprint, status, lease_token, lease_expires_at,
              result_payload, http_status
         from legal_source_operations
        where user_id = $1 and request_key = $2`,
      [input.userId, input.requestKey],
    )
  ).rows[0];
  if (!existing || existing.request_fingerprint !== input.fingerprint) return { kind: "conflict" };
  if (existing.status !== "dispatching") {
    return {
      kind: "replay",
      status: Number(existing.http_status || (existing.status === "succeeded" ? 200 : 422)),
      payload: { ...(existing.result_payload || {}), replayed: true },
    };
  }
  const claimed = await pool.query<{ id: string | number }>(
    `update legal_source_operations
        set lease_token = $3, lease_expires_at = now() + interval '90 seconds', updated_at = now()
      where user_id = $1 and request_key = $2 and status = 'dispatching'
        and (lease_expires_at is null or lease_expires_at <= now())
      returning id`,
    [input.userId, input.requestKey, leaseToken],
  );
  return claimed.rows[0]
    ? { kind: "claimed", id: Number(claimed.rows[0].id), leaseToken }
    : { kind: "in_progress" };
}

async function finishOperation(
  queryable: Queryable,
  operationId: number,
  leaseToken: string,
  status: "succeeded" | "failed",
  httpStatus: number,
  payload: Record<string, unknown>,
  errorCode: string | null = null,
) {
  const updated = await queryable.query(
    `update legal_source_operations
        set status = $3, result_payload = $4::jsonb, http_status = $5,
            last_error_code = $6, lease_token = null, lease_expires_at = null,
            updated_at = now()
      where id = $1 and lease_token = $2 and status = 'dispatching'`,
    [operationId, leaseToken, status, JSON.stringify(payload), httpStatus, errorCode],
  );
  if (updated.rowCount !== 1) throw new Error("legal_operation_lease_lost");
}

async function releaseRetryableOperation(queryable: Queryable, operationId: number, leaseToken: string, code: string) {
  await queryable.query(
    `update legal_source_operations
        set lease_expires_at = now(), last_error_code = $3, updated_at = now()
      where id = $1 and lease_token = $2 and status = 'dispatching'`,
    [operationId, leaseToken, code],
  );
}

function reservationResult(
  reserved: Awaited<ReturnType<typeof reserveOperation>>,
): LegalServiceResult | null {
  if (reserved.kind === "replay") return { status: reserved.status, body: reserved.payload, replayed: true };
  if (reserved.kind === "conflict") return { status: 409, body: { ok: false, error: "idempotency_conflict" } };
  if (reserved.kind === "in_progress") return { status: 409, body: { ok: false, error: "operation_in_progress" } };
  return null;
}

async function providerFailureResult(
  pool: Queryable,
  operationId: number,
  leaseToken: string,
  error: unknown,
): Promise<LegalServiceResult> {
  const failure = safeLegalError(error);
  const payload = { ok: false, error: failure.code, retryable: failure.retryable };
  if (failure.retryable) {
    await releaseRetryableOperation(pool, operationId, leaseToken, failure.code);
  } else {
    await finishOperation(pool, operationId, leaseToken, "failed", failure.status, payload, failure.code);
  }
  return { status: failure.status, body: payload };
}

export async function listLegalSourceState(
  pool: Queryable,
  userId: number,
  options: ServiceOptions = {},
) {
  const providers = registry(options).map(publicLegalProvider);
  const connections = await pool.query<LegalConnectionRow>(
    `select ${CONNECTION_FIELDS}
       from legal_source_connections
      where user_id = $1
      order by (status = 'connected') desc, updated_at desc, id desc`,
    [userId],
  );
  const counts = await pool.query<{ legal_type: string; count: string | number }>(
    `select legal_type, count(*)::int as count
       from legal_source_fragments
      where user_id = $1
      group by legal_type`,
    [userId],
  );
  return {
    providers,
    connections: connections.rows.map(serializeLegalConnection),
    fragmentCounts: Object.fromEntries(counts.rows.map((row) => [row.legal_type, Number(row.count)])),
  };
}

export async function connectLegalSource(
  pool: LegalPool,
  input: { userId: number; requestKey: string; providerId: string; token: string },
  options: ServiceOptions = {},
): Promise<LegalServiceResult> {
  const fingerprint = legalOperationFingerprint({
    operation: "connect",
    providerId: input.providerId,
    token: input.token,
  });
  const reserved = await reserveOperation(pool, {
    userId: input.userId,
    connectionId: null,
    providerId: input.providerId,
    operation: "connect",
    requestKey: input.requestKey,
    fingerprint,
  });
  const immediate = reservationResult(reserved);
  if (immediate) return immediate;
  const { id: operationId, leaseToken } = reserved as Extract<typeof reserved, { kind: "claimed" }>;

  let provider;
  try {
    provider = getLegalProvider(input.providerId, registry(options));
  } catch (error) {
    return providerFailureResult(pool, operationId, leaseToken, error);
  }
  if (provider.kind !== "official_api" && provider.kind !== "licensed_integration") {
    const payload = { ok: false, error: "token_connection_not_supported", retryable: false };
    await finishOperation(pool, operationId, leaseToken, "failed", 422, payload, "token_connection_not_supported");
    return { status: 422, body: payload };
  }

  let connected;
  try {
    connected = await adapter(provider, options).connect({ token: input.token, idempotencyKey: input.requestKey });
  } catch (error) {
    return providerFailureResult(pool, operationId, leaseToken, error);
  }

  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch {
    await releaseRetryableOperation(pool, operationId, leaseToken, "database_unavailable");
    return { status: 503, body: { ok: false, error: "database_unavailable", retryable: true } };
  }
  try {
    await client.query("begin");
    const envelope = encryptToken(input.token, { userId: input.userId, provider: providerContext(provider.id) });
    const result = await client.query<LegalConnectionRow>(
      `insert into legal_source_connections
         (user_id, provider_id, provider_label, integration_kind, token_envelope,
          status, subscription_status, external_account_label, token_expires_at,
          last_error_code, last_error_message, disconnected_at)
       values ($1, $2, $3, $4, $5, 'connected', $6, $7, $8, null, null, null)
       on conflict (user_id, provider_id) do update
         set provider_label = excluded.provider_label,
             integration_kind = excluded.integration_kind,
             token_envelope = excluded.token_envelope,
             status = 'connected', subscription_status = excluded.subscription_status,
             external_account_label = excluded.external_account_label,
             token_expires_at = excluded.token_expires_at,
             last_error_code = null, last_error_message = null,
             disconnected_at = null, updated_at = now()
       returning ${CONNECTION_FIELDS}`,
      [
        input.userId,
        provider.id,
        provider.label,
        provider.kind,
        envelope,
        connected.subscriptionStatus,
        connected.accountLabel,
        connected.tokenExpiresAt,
      ],
    );
    const connection = result.rows[0];
    const payload = { ok: true, connection: serializeLegalConnection(connection) };
    await client.query(
      `update legal_source_operations set connection_id = $3 where id = $1 and lease_token = $2`,
      [operationId, leaseToken, connection.id],
    );
    await finishOperation(client, operationId, leaseToken, "succeeded", 201, payload);
    await client.query("commit");
    return { status: 201, body: payload };
  } catch {
    await client.query("rollback").catch(() => undefined);
    await releaseRetryableOperation(pool, operationId, leaseToken, "database_unavailable").catch(() => undefined);
    return { status: 503, body: { ok: false, error: "database_unavailable", retryable: true } };
  } finally {
    client.release();
  }
}

async function getOwnedConnection(pool: Queryable, userId: number, connectionId: number) {
  return (
    await pool.query<StoredConnectionRow>(
      `select ${STORED_CONNECTION_FIELDS}
         from legal_source_connections
        where id = $1 and user_id = $2`,
      [connectionId, userId],
    )
  ).rows[0] || null;
}

async function persistFragments(client: PoolClient, userId: number, connectionId: number, providerId: string, records: LegalRecord[]) {
  let fragmentCount = 0;
  for (const record of records) {
    for (const fragment of record.fragments) {
      await client.query(
        `insert into legal_source_fragments
           (user_id, connection_id, provider_id, external_id, fragment_index,
            legal_type, title, content, source_name, source_date, currentness,
            source_url, relevant_at, metadata, synced_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 jsonb_build_object('provenanceVersion', 1), now())
         on conflict (user_id, provider_id, external_id, fragment_index) do update
           set connection_id = excluded.connection_id, legal_type = excluded.legal_type,
               title = excluded.title, content = excluded.content,
               source_name = excluded.source_name, source_date = excluded.source_date,
               currentness = excluded.currentness, source_url = excluded.source_url,
               relevant_at = excluded.relevant_at, metadata = excluded.metadata,
               synced_at = now()`,
        [
          userId,
          connectionId,
          providerId,
          record.externalId,
          fragment.fragmentIndex,
          record.legalType,
          record.title,
          fragment.text,
          fragment.sourceName,
          fragment.sourceDate,
          fragment.currentness,
          fragment.sourceUrl,
          record.relevantAt,
        ],
      );
      fragmentCount += 1;
    }
  }
  return fragmentCount;
}

export async function runLegalSourceAction(
  pool: LegalPool,
  input: { userId: number; connectionId: number; requestKey: string; action: LegalAction },
  options: ServiceOptions = {},
): Promise<LegalServiceResult> {
  const connection = await getOwnedConnection(pool, input.userId, input.connectionId);
  if (!connection) return { status: 404, body: { ok: false, error: "not_found" } };
  const fingerprint = legalOperationFingerprint({
    operation: input.action,
    providerId: connection.provider_id,
    connectionId: input.connectionId,
  });
  const reserved = await reserveOperation(pool, {
    userId: input.userId,
    connectionId: input.connectionId,
    providerId: connection.provider_id,
    operation: input.action,
    requestKey: input.requestKey,
    fingerprint,
  });
  const immediate = reservationResult(reserved);
  if (immediate) return immediate;
  const { id: operationId, leaseToken } = reserved as Extract<typeof reserved, { kind: "claimed" }>;

  let provider;
  try {
    provider = getLegalProvider(connection.provider_id, registry(options));
  } catch (error) {
    return providerFailureResult(pool, operationId, leaseToken, error);
  }
  if (!connection.token_envelope) {
    const payload = { ok: false, error: "credential_unavailable", retryable: false };
    await finishOperation(pool, operationId, leaseToken, "failed", 422, payload, "credential_unavailable");
    return { status: 422, body: payload };
  }

  let token;
  try {
    token = decryptToken(connection.token_envelope, {
      userId: input.userId,
      provider: providerContext(provider.id),
    });
  } catch {
    const payload = { ok: false, error: "credential_unavailable", retryable: false };
    await finishOperation(pool, operationId, leaseToken, "failed", 422, payload, "credential_unavailable");
    return { status: 422, body: payload };
  }

  const providerAdapter = adapter(provider, options);
  let result: Awaited<ReturnType<typeof providerAdapter[typeof input.action]>>;
  try {
    if (input.action === "sync") {
      result = await providerAdapter.sync({ token, cursor: connection.sync_cursor, idempotencyKey: input.requestKey });
    } else if (input.action === "disconnect") {
      result = await providerAdapter.disconnect({ token, idempotencyKey: input.requestKey });
    } else if (input.action === "validate") {
      result = await providerAdapter.validate({ token, idempotencyKey: input.requestKey });
    } else {
      result = await providerAdapter.health({ token, idempotencyKey: input.requestKey });
    }
  } catch (error) {
    const failure = safeLegalError(error);
    await pool.query(
      `update legal_source_connections
          set last_error_code = $3, last_error_message = $4,
              status = case
                when $3 = 'provider_credentials_rejected' then 'invalid'
                when $3 = 'subscription_inactive' then 'expired'
                else status
              end,
              updated_at = now()
        where id = $1 and user_id = $2`,
      [input.connectionId, input.userId, failure.code, connectionErrorMessage(failure.code)],
    ).catch(() => undefined);
    return providerFailureResult(pool, operationId, leaseToken, error);
  }

  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch {
    await releaseRetryableOperation(pool, operationId, leaseToken, "database_unavailable");
    return { status: 503, body: { ok: false, error: "database_unavailable", retryable: true } };
  }
  try {
    await client.query("begin");
    let payload: Record<string, unknown>;
    if (input.action === "sync") {
      const sync = result as Awaited<ReturnType<typeof providerAdapter.sync>>;
      const fragmentCount = await persistFragments(client, input.userId, input.connectionId, provider.id, sync.fragments);
      await client.query(
        `update legal_source_connections
            set sync_cursor = $3, last_sync_at = now(), last_health_at = now(),
                status = 'connected', last_error_code = null, last_error_message = null,
                updated_at = now()
          where id = $1 and user_id = $2`,
        [input.connectionId, input.userId, sync.cursor],
      );
      payload = { ok: true, action: "sync", fragmentCount };
    } else if (input.action === "disconnect") {
      await client.query(
        `update legal_source_connections
            set token_envelope = null, status = 'disconnected', disconnected_at = now(),
                sync_cursor = null, last_error_code = null, last_error_message = null,
                updated_at = now()
          where id = $1 and user_id = $2`,
        [input.connectionId, input.userId],
      );
      payload = { ok: true, action: "disconnect", disconnected: true };
    } else if (input.action === "validate") {
      const validation = result as Awaited<ReturnType<typeof providerAdapter.validate>>;
      await client.query(
        `update legal_source_connections
            set status = case when $3 then 'connected' else 'invalid' end,
                subscription_status = $4, token_expires_at = coalesce($5, token_expires_at),
                last_health_at = now(),
                last_error_code = case when $3 then null else 'provider_credentials_rejected' end,
                last_error_message = case when $3 then null else 'API-токен требует повторной проверки.' end,
                updated_at = now()
          where id = $1 and user_id = $2`,
        [input.connectionId, input.userId, validation.valid, validation.subscriptionStatus, validation.tokenExpiresAt],
      );
      payload = { ok: true, action: "validate", valid: validation.valid };
    } else {
      const health = result as Awaited<ReturnType<typeof providerAdapter.health>>;
      await client.query(
        `update legal_source_connections
            set status = case when $3 then 'connected' else status end,
                subscription_status = $4, token_expires_at = coalesce($5, token_expires_at),
                last_health_at = now(),
                last_error_code = case when $3 then null else 'provider_unhealthy' end,
                last_error_message = case when $3 then null else 'Провайдер сообщил о проблеме подключения.' end,
                updated_at = now()
          where id = $1 and user_id = $2`,
        [input.connectionId, input.userId, health.healthy, health.subscriptionStatus, health.tokenExpiresAt],
      );
      payload = { ok: true, action: "health", healthy: health.healthy };
    }
    await finishOperation(client, operationId, leaseToken, "succeeded", 200, payload);
    await client.query("commit");
    return { status: 200, body: payload };
  } catch {
    await client.query("rollback").catch(() => undefined);
    await releaseRetryableOperation(pool, operationId, leaseToken, "database_unavailable").catch(() => undefined);
    return { status: 503, body: { ok: false, error: "database_unavailable", retryable: true } };
  } finally {
    client.release();
  }
}

export function isLegalProviderNotConfigured(error: unknown) {
  return error instanceof LegalProviderError && error.code === "not_configured";
}
