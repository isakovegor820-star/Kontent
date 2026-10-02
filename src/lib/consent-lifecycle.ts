import type { Pool, PoolClient } from "pg";

import { CONSENT_KINDS, recordConsent, type ConsentKind, type ConsentSource } from "./consent";

/**
 * Жизненный цикл согласия: чтение текущего состояния и отзыв.
 *
 * Журнал `consents` — append-only, поэтому «текущее согласие» это не колонка,
 * а последняя запись по виду. Здесь собраны оба действия, которые нужны
 * кабинету и оператору: показать, на что человек согласился, и отозвать это
 * согласие новой записью (ч. 2 ст. 9, ч. 5 ст. 21 152-ФЗ — отзыв не удаляет
 * историю, иначе оператор не докажет, что обработка была законной до отзыва).
 */

type Queryable = Pick<Pool | PoolClient, "query">;

export type ConsentState = {
  kind: ConsentKind;
  /** Актуальное состояние: true — согласие действует, false — отозвано. */
  granted: boolean;
  /** Момент последней записи по этому виду. */
  changedAt: string;
  /** Версия текста, на которой человек согласился (для доказательства). */
  consentTextVersion: string | null;
  /** Версия политики на тот момент. */
  policyVersion: string | null;
  /** Где получено согласие. */
  source: string | null;
};

/** Разбирает строку журнала в состояние. Отдельно — чтобы тестировать без БД. */
export function toConsentState(row: {
  kind: string;
  granted: boolean;
  granted_at: Date | string;
  consent_text_version: string | null;
  policy_version: string | null;
  source: string | null;
}): ConsentState {
  return {
    kind: row.kind as ConsentKind,
    granted: row.granted === true,
    changedAt: row.granted_at instanceof Date ? row.granted_at.toISOString() : String(row.granted_at),
    consentTextVersion: row.consent_text_version,
    policyVersion: row.policy_version,
    source: row.source,
  };
}

/**
 * Читает актуальное состояние по каждому виду согласия пользователя.
 *
 * `distinct on (kind)` + сортировка по времени: берём последнюю запись каждого
 * вида. Виды, по которым записей нет, возвращаются как «согласия нет» — это
 * важно для интерфейса, который обязан показать не только данное согласие,
 * но и отсутствие согласия на рассылки.
 */
export async function listUserConsents(client: Queryable, userId: number): Promise<ConsentState[]> {
  const result = await client.query<{
    kind: string;
    granted: boolean;
    granted_at: Date | string;
    consent_text_version: string | null;
    policy_version: string | null;
    source: string | null;
  }>(
    `select distinct on (kind)
            kind, granted, granted_at, consent_text_version, policy_version, source
       from consents
      where user_id = $1
      order by kind, granted_at desc, id desc`,
    [userId],
  );

  const byKind = new Map(result.rows.map((row) => [row.kind, toConsentState(row)]));
  // Порядок видов фиксирован CONSENT_KINDS: интерфейс не должен переставлять
  // строки от запроса к запросу. Отсутствующие виды показываем как «нет».
  return CONSENT_KINDS.map(
    (kind) =>
      byKind.get(kind) ?? {
        kind,
        granted: false,
        changedAt: "",
        consentTextVersion: null,
        policyVersion: null,
        source: null,
      },
  );
}

/** Читает актуальное состояние одного вида согласия. */
export async function readConsentState(
  client: Queryable,
  userId: number,
  kind: ConsentKind,
): Promise<ConsentState | null> {
  const result = await client.query<{
    kind: string;
    granted: boolean;
    granted_at: Date | string;
    consent_text_version: string | null;
    policy_version: string | null;
    source: string | null;
  }>(
    `select kind, granted, granted_at, consent_text_version, policy_version, source
       from consents
      where user_id = $1 and kind = $2
      order by granted_at desc, id desc
      limit 1`,
    [userId, kind],
  );
  const row = result.rows[0];
  return row ? toConsentState(row) : null;
}

/** Действующее согласие вида: нужно перед тем, как писать отзыв. */
export async function hasActiveConsent(
  client: Queryable,
  userId: number,
  kind: ConsentKind,
): Promise<boolean> {
  return (await readConsentState(client, userId, kind))?.granted === true;
}

export type RevokeResult = { ok: true; revoked: boolean } | { ok: false; error: "not_granted" };

/**
 * Отзывает согласие новой записью журнала.
 *
 * Повторный отзыв не создаёт вторую строку: если действующего согласия нет,
 * возвращаем `not_granted`. Иначе журнал заполнится одинаковыми отзывами,
 * и по нему нельзя будет понять, когда человек отозвал согласие на самом деле.
 */
export async function revokeConsent(
  client: Queryable,
  input: {
    userId: number;
    kind: ConsentKind;
    ip?: string | null;
    userAgent?: string | null;
    source?: ConsentSource;
  },
): Promise<RevokeResult> {
  if (!(await hasActiveConsent(client, input.userId, input.kind))) {
    return { ok: false, error: "not_granted" };
  }
  await recordConsent(client, {
    userId: input.userId,
    kind: input.kind,
    granted: false,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    source: input.source ?? "cabinet",
  });
  return { ok: true, revoked: true };
}

export type ConsentHistoryEntry = {
  kind: ConsentKind;
  granted: boolean;
  at: string;
  source: string | null;
  consentTextVersion: string | null;
  policyVersion: string | null;
  /** Есть ли адрес запроса: сам адрес не показываем, только факт фиксации. */
  hasIp: boolean;
  hasUserAgent: boolean;
};

/**
 * Полная история согласий пользователя — для выгрузки доказательства.
 *
 * Адрес и клиентский агент не возвращаем: выгрузка уходит в интерфейс, а
 * в журнале они лежат как доказательство для оператора, не для показа.
 */
export async function listConsentHistory(
  client: Queryable,
  userId: number,
): Promise<ConsentHistoryEntry[]> {
  const result = await client.query<{
    kind: string;
    granted: boolean;
    granted_at: Date | string;
    source: string | null;
    consent_text_version: string | null;
    policy_version: string | null;
    ip: string | null;
    user_agent: string | null;
  }>(
    `select kind, granted, granted_at, source, consent_text_version, policy_version, ip, user_agent
       from consents
      where user_id = $1
      order by granted_at desc, id desc`,
    [userId],
  );
  return result.rows.map((row) => ({
    kind: row.kind as ConsentKind,
    granted: row.granted === true,
    at: row.granted_at instanceof Date ? row.granted_at.toISOString() : String(row.granted_at),
    source: row.source,
    consentTextVersion: row.consent_text_version,
    policyVersion: row.policy_version,
    hasIp: Boolean(row.ip),
    hasUserAgent: Boolean(row.user_agent),
  }));
}
