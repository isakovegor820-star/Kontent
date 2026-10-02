import type { Pool, PoolClient } from "pg";

/**
 * Согласия на обработку персональных данных: единая точка записи.
 *
 * Причина отдельного модуля: согласие требуется в разных местах (регистрация,
 * лид-форма, кабинет), и все они обязаны писать одинаковый набор доказательств —
 * вид согласия, время, версию текста, версию политики, адрес запроса и клиента.
 * Разъедутся формулировки или версии — согласие станет недоказуемым (ч. 1, ч. 3
 * ст. 9 152-ФЗ), а именно доказательство и есть его смысл.
 *
 * Версию определяет сервер, а не клиент: значение из тела запроса можно
 * подделать, и тогда в журнале окажется текст, которого пользователь не видел.
 * Тексты живут в правовых документах; здесь только их версии.
 */

/** Виды согласия. CHECK в схеме нет намеренно: новый вид не должен требовать миграции. */
export const CONSENT_KINDS = ["pd_processing", "marketing", "pd_distribution", "cookie"] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];

/**
 * Версия текста согласия. Меняется вместе с утверждённой редакцией документа
 * `/consent`; до утверждения помечена как проект, чтобы в журнале было видно,
 * на каком тексте человек согласился.
 */
export const CONSENT_TEXT_VERSION = "draft-2026-10";

/** Версия политики обработки персональных данных на момент согласия. */
export const POLICY_VERSION = "2026-08-24";

/** Источники согласия: где именно оно получено. */
export const CONSENT_SOURCES = ["register", "lead", "sites", "cabinet"] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

export type ConsentRequestFacts = {
  ip: string | null;
  userAgent: string | null;
  source: ConsentSource;
};

export type ParsedConsentFlag =
  | { ok: true; granted: boolean }
  | { ok: false; error: "consent_required" };

/**
 * Разбирает признак согласия из тела запроса.
 *
 * Строгий разбор без приведения типов: строка «true», число 1 и любой другой
 * объект согласием не считаются. Согласие — это явное действие пользователя,
 * а не истинное значение в JavaScript.
 */
export function parseConsentFlag(value: unknown): ParsedConsentFlag {
  if (value === true) return { ok: true, granted: true };
  if (value === false || value === undefined || value === null) return { ok: true, granted: false };
  return { ok: false, error: "consent_required" };
}

/**
 * Проверка обязательности согласия.
 *
 * Пока платформа разворачивается поэтапно (трек A плана 152-ФЗ), приём согласия
 * уже работает, а обязательность включается отдельным решением — оно требует
 * утверждённых текстов, иначе чекбокс остаётся формальностью. Флаг включается
 * одной переменной окружения, без правки маршрутов.
 */
export function isConsentRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AURORA_CONSENT_REQUIRED === "1";
}

export type ConsentRecord = {
  userId?: number | null;
  contact?: string | null;
  kind: ConsentKind;
  granted: boolean;
  ip?: string | null;
  userAgent?: string | null;
  policyVersion?: string;
  consentTextVersion?: string;
  source: ConsentSource;
};

type Queryable = Pick<Pool | PoolClient, "query">;

/** Порядок в журнале: сначала вид, затем свежие записи. */
export const CONSENT_HISTORY_ORDER = "kind asc, granted_at desc, id desc";

/**
 * Записывает согласие или отзыв.
 *
 * Только вставка: журнал append-only, отзыв — новая строка с granted=false.
 * Ошибку не глотаем: если запись не удалась, вызывающий код обязан откатить
 * транзакцию — согласие без доказательства хуже, чем отказ в операции.
 */
export async function recordConsent(client: Queryable, record: ConsentRecord): Promise<void> {
  await client.query(
    `insert into consents (
       user_id, contact, kind, granted, ip, user_agent,
       policy_version, consent_text_version, source
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      record.userId ?? null,
      record.contact ?? null,
      record.kind,
      record.granted,
      record.ip ?? null,
      record.userAgent ?? null,
      record.policyVersion ?? POLICY_VERSION,
      record.consentTextVersion ?? CONSENT_TEXT_VERSION,
      record.source,
    ],
  );
}

/** Собирает факты запроса для доказательства: адрес и клиент. */
export function consentFactsFromHeaders(
  headers: Headers,
  ip: string | null,
  source: ConsentSource,
): ConsentRequestFacts {
  return {
    ip,
    userAgent: headers.get("user-agent")?.slice(0, 400) ?? null,
    source,
  };
}
