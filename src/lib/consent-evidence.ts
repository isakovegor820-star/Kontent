import type { Pool } from "pg";

/**
 * Операторская сторона согласий: поиск доказательств по аккаунту и по контакту.
 *
 * Зачем отдельный модуль: доказательство нужно поддержке и юристу, а не
 * пользователю. Два разных случая требуют разных запросов:
 *  - владелец аккаунта пишет из интерфейса или по почте — ищем по user_id или
 *    по адресу аккаунта;
 *  - человек оставил заявку через лид-форму и аккаунта не имеет — согласие
 *    привязано к контакту, и найти его можно только по контакту.
 *
 * Возвращаем и текущее состояние, и полную историю: по журналу видно, когда
 * согласие дано, на каком тексте и когда отозвано (ч. 3 ст. 9 152-ФЗ — бремя
 * доказывания на операторе).
 */

type Queryable = Pick<Pool, "query">;

export type ConsentEvidenceRow = {
  id: number;
  userId: number | null;
  contact: string | null;
  kind: string;
  granted: boolean;
  grantedAt: string;
  source: string | null;
  policyVersion: string | null;
  consentTextVersion: string | null;
  /** Есть ли адрес и клиентский агент: сами значения показываем только выгрузкой. */
  hasIp: boolean;
  hasUserAgent: boolean;
};

export type ConsentEvidence = {
  account: {
    id: number;
    email: string | null;
    name: string | null;
    status: "active" | "blocked" | "deleted";
  } | null;
  /** Строки журнала: сначала свежие. */
  rows: ConsentEvidenceRow[];
  /** Контакт, по которому нашлись согласия без аккаунта (заявка с формы). */
  leadContact: string | null;
  /** Заявка с таким контактом: подтверждает, что человек оставлял форму. */
  lead: { id: number; contact: string; source: string | null; createdAt: string | null } | null;
};

const iso = (value: Date | string | null) =>
  value == null ? null : value instanceof Date ? value.toISOString() : String(value);

function mapRow(row: ConsentRow): ConsentEvidenceRow {
  return {
    id: row.id,
    userId: row.user_id,
    contact: row.contact,
    kind: row.kind,
    granted: row.granted === true,
    grantedAt: iso(row.granted_at) ?? "",
    source: row.source,
    policyVersion: row.policy_version,
    consentTextVersion: row.consent_text_version,
    hasIp: Boolean(row.ip),
    hasUserAgent: Boolean(row.user_agent),
  };
}

const ROW_COLUMNS = `id, user_id, contact, kind, granted, granted_at, source,
                     policy_version, consent_text_version, ip, user_agent`;

/** Строка журнала как она приходит из базы — до преобразования в ConsentEvidenceRow. */
type ConsentRow = {
  id: number;
  user_id: number | null;
  contact: string | null;
  kind: string;
  granted: boolean;
  granted_at: Date | string;
  source: string | null;
  policy_version: string | null;
  consent_text_version: string | null;
  ip: string | null;
  user_agent: string | null;
};

/**
 * Находит согласия по аккаунту и/или контакту.
 *
 * Контакт нормализуем в нижний регистр: и `leads.contact`, и адреса аккаунтов
 * хранятся так же, иначе поиск не найдёт человека из-за регистра в письме.
 */
export async function findConsentEvidence(
  client: Queryable,
  input: { userId?: number | null; contact?: string | null },
): Promise<ConsentEvidence> {
  const userId = Number.isInteger(input.userId) ? Number(input.userId) : null;
  const contact = typeof input.contact === "string" ? input.contact.trim().toLowerCase() : "";
  if (userId === null && !contact) {
    return { account: null, rows: [], leadContact: null, lead: null };
  }

  const accountResult = userId !== null
    ? await client.query<{
        id: number;
        email: string | null;
        name: string | null;
        blocked_at: Date | string | null;
      }>(
        `select id, email, name, blocked_at from users where id = $1`,
        [userId],
      )
    : contact
      ? await client.query<{
          id: number;
          email: string | null;
          name: string | null;
          blocked_at: Date | string | null;
        }>(
          `select id, email, name, blocked_at from users where lower(email) = $1`,
          [contact],
        )
      : { rows: [] };

  const accountRow = accountResult.rows[0] ?? null;
  const resolvedUserId = accountRow?.id ?? userId;

  // Ищем по аккаунту и по контакту одновременно: у человека мог быть аккаунт,
  // а заявка при этом пришла с другой формы и другого адреса.
  const rowsResult = await client.query<ConsentRow>(
    `select ${ROW_COLUMNS}
       from consents
      where ($1::bigint is not null and user_id = $1)
         or ($2::text <> '' and lower(contact) = $2)
      order by granted_at desc, id desc
      limit 200`,
    [resolvedUserId ?? null, contact],
  );

  const leadResult = contact
    ? await client.query<{
        id: number;
        contact: string;
        source: string | null;
        created_at: Date | string | null;
      }>(
        `select id, contact, source, created_at from leads where lower(contact) = $1 limit 1`,
        [contact],
      )
    : { rows: [] };
  const leadRow = leadResult.rows[0] ?? null;

  return {
    account: accountRow
      ? {
          id: accountRow.id,
          email: accountRow.email,
          name: accountRow.name,
          // Аккаунт с обезличенной почтой — уже удалённый: support не должен
          // обещать человеку восстановление.
          status: accountRow.email?.endsWith("@deleted.invalid")
            ? "deleted"
            : accountRow.blocked_at
              ? "blocked"
              : "active",
        }
      : null,
    rows: rowsResult.rows.map(mapRow),
    leadContact: contact || null,
    lead: leadRow
      ? {
          id: leadRow.id,
          contact: leadRow.contact,
          source: leadRow.source,
          createdAt: iso(leadRow.created_at),
        }
      : null,
  };
}

/** Текущее состояние по видам: для карточки поддержки это главное. */
export function summarizeConsentState(rows: ConsentEvidenceRow[]) {
  const latest = new Map<string, ConsentEvidenceRow>();
  for (const row of rows) {
    // Строки уже отсортированы по времени вниз, поэтому первая по виду — свежая.
    if (!latest.has(row.kind)) latest.set(row.kind, row);
  }
  return [...latest.values()].map((row) => ({
    kind: row.kind,
    granted: row.granted,
    changedAt: row.grantedAt,
    consentTextVersion: row.consentTextVersion,
    policyVersion: row.policyVersion,
    source: row.source,
  }));
}

/**
 * Выгрузка доказательств в CSV.
 *
 * Формат выбран из-за потребителя: юрист и поддержка работают с таблицей, а не
 * с JSON. Экранирование по RFC 4180: кавычка удваивается, поле оборачивается
 * в кавычки, если содержит запятую, кавычку или перевод строки.
 */
export function consentEvidenceCsv(rows: ConsentEvidenceRow[]): string {
  const header = [
    "id",
    "user_id",
    "contact",
    "kind",
    "granted",
    "granted_at",
    "source",
    "consent_text_version",
    "policy_version",
    "ip_recorded",
    "user_agent_recorded",
  ];
  const escape = (value: unknown) => {
    const text = value == null ? "" : String(value);
    return /[",\n\r]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
  };
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.userId ?? "",
        row.contact ?? "",
        row.kind,
        row.granted ? "true" : "false",
        row.grantedAt,
        row.source ?? "",
        row.consentTextVersion ?? "",
        row.policyVersion ?? "",
        row.hasIp ? "yes" : "no",
        row.hasUserAgent ? "yes" : "no",
      ]
        .map(escape)
        .join(","),
    );
  }
  // BOM нужен Excel: без него кириллица в CSV читается как мусор.
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
