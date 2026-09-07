import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { classifyTelegramDelivery, readTelegramResponse } from "./telegram-response.mjs";
import type { StoredAdminAlertNotification } from "./admin-alert-ledger";
export { AdminAlertTracker } from "./admin-alert-ledger";

import { probeRedisAndPublicationWorker } from "./readiness-probes";

export type AdminAlertId = "database" | "redis" | "publication_worker" | "telegram_worker" | "overdue_publications";
export type AdminAlertSeverity = "critical" | "warning";

export interface AdminAlertCondition {
  id: AdminAlertId;
  firing: boolean;
  severity: AdminAlertSeverity;
  detail: string;
}

export interface AdminAlertNotification {
  id: AdminAlertId;
  kind: "fired" | "still_firing" | "recovered";
  severity: AdminAlertSeverity;
  detail: string;
  sinceMs: number;
}

export const ADMIN_ALERT_DEFAULTS = Object.freeze({
  intervalMs: 5 * 60_000,
  repeatMs: 6 * 60 * 60_000,
  overdueThreshold: 5,
});

const ALERT_LABEL: Record<AdminAlertId, string> = {
  database: "PostgreSQL недоступен",
  redis: "Redis недоступен",
  publication_worker: "Воркер публикаций не подтверждает heartbeat",
  telegram_worker: "Telegram-воркер не принимает команды",
  overdue_publications: "Публикации застряли в очереди",
};

const ALERT_HREF: Record<AdminAlertId, string> = {
  database: "/admin?system=postgresql#system",
  redis: "/admin?system=redis#system",
  publication_worker: "/admin?system=publication_worker#system",
  telegram_worker: "/admin?system=telegram_worker#system",
  overdue_publications: "/admin?pstatus=overdue#publications",
};

export function adminAlertsConfig(env: Record<string, string | undefined> = process.env) {
  const number = (value: string | undefined, fallback: number, min: number, max: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? Math.round(parsed) : fallback;
  };
  return {
    enabled: env.AURORA_ADMIN_ALERTS !== "off",
    intervalMs: number(env.AURORA_ADMIN_ALERTS_INTERVAL_MS, ADMIN_ALERT_DEFAULTS.intervalMs, 30_000, 60 * 60_000),
    repeatMs: number(env.AURORA_ADMIN_ALERTS_REPEAT_MS, ADMIN_ALERT_DEFAULTS.repeatMs, 5 * 60_000, 7 * 24 * 60 * 60_000),
    overdueThreshold: number(env.AURORA_ADMIN_ALERTS_OVERDUE_THRESHOLD, ADMIN_ALERT_DEFAULTS.overdueThreshold, 1, 100_000),
  };
}

/**
 * Evaluates the few conditions an on-call admin must hear about immediately. Each probe
 * is independent: a database outage still lets Redis/worker checks report.
 */
export async function evaluateAdminAlertConditions(input: {
  pool: Pick<Pool, "query">;
  overdueThreshold: number;
  probe?: typeof probeRedisAndPublicationWorker;
}): Promise<AdminAlertCondition[]> {
  const probe = input.probe ?? probeRedisAndPublicationWorker;
  const [queue, overdue] = await Promise.allSettled([
    probe(),
    input.pool.query<{ overdue: number | string }>(
      `select count(*) as overdue from posts
        where status = 'scheduled' and scheduled_at < now() - interval '5 minutes'`,
    ),
  ]);

  const conditions: AdminAlertCondition[] = [];
  if (overdue.status === "rejected") {
    conditions.push({ id: "database", firing: true, severity: "critical", detail: "Запрос к базе не выполнился" });
  } else {
    const count = Number(overdue.value.rows[0]?.overdue ?? 0);
    conditions.push({ id: "database", firing: false, severity: "critical", detail: "База отвечает" });
    conditions.push({
      id: "overdue_publications",
      firing: count >= input.overdueThreshold,
      severity: "warning",
      detail: `${count} запланированных публикаций старше 5 минут (порог ${input.overdueThreshold})`,
    });
  }

  if (queue.status === "rejected") {
    conditions.push({ id: "redis", firing: true, severity: "critical", detail: "Проверка Redis не завершилась" });
  } else {
    const state = queue.value;
    if (state.redis !== "not_configured") {
      conditions.push({ id: "redis", firing: state.redis !== "up", severity: "critical", detail: state.redis === "up" ? "PING успешен" : "PING не отвечает" });
      conditions.push({
        id: "publication_worker",
        firing: state.redis === "up" && state.publicationWorker !== "up",
        severity: "critical",
        detail: state.publicationWorker === "up" ? "Heartbeat свежий" : "Heartbeat отсутствует или устарел",
      });
    }
    if (state.telegramPolling !== "not_configured") {
      conditions.push({
        id: "telegram_worker",
        firing: state.telegramPolling !== "up",
        severity: state.telegramPolling === "conflict" ? "critical" : "warning",
        detail: state.telegramPolling === "up" ? "Polling heartbeat свежий"
          : state.telegramPolling === "conflict" ? "Второй процесс читает обновления бота" : "Polling heartbeat отсутствует",
      });
    }
  }
  return conditions;
}

function escapeHtml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function durationLabel(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} ч ${minutes % 60} мин` : `${Math.floor(hours / 24)} д`;
}

export function formatAdminAlertMessage(notification: AdminAlertNotification, appUrl: string | null, nowMs = Date.now()): string {
  const icon = notification.kind === "recovered" ? "✅" : notification.severity === "critical" ? "🔴" : "🟠";
  const headline = notification.kind === "recovered"
    ? `Восстановлено: ${ALERT_LABEL[notification.id]}`
    : notification.kind === "still_firing"
      ? `Всё ещё: ${ALERT_LABEL[notification.id]} (${durationLabel(nowMs - notification.sinceMs)})`
      : ALERT_LABEL[notification.id];
  const lines = [`${icon} <b>Аврора · ${escapeHtml(headline)}</b>`, escapeHtml(notification.detail)];
  if (appUrl) lines.push(`<a href="${escapeHtml(`${appUrl.replace(/\/+$/u, "")}${ALERT_HREF[notification.id]}`)}">Открыть в админ-панели</a>`);
  return lines.join("\n");
}

/** Admins from the server allowlist who linked a Telegram chat; nobody else ever receives alerts. */
export async function adminAlertRecipients(
  pool: Pick<Pool, "query">,
  env: Record<string, string | undefined> = process.env,
): Promise<Array<{ userId: number; chatId: string }>> {
  const ids = String(env.AURORA_ADMIN_USER_IDS || "").split(",").map((item) => Number(item.trim())).filter((item) => Number.isSafeInteger(item) && item > 0);
  const emails = String(env.AURORA_ADMIN_EMAILS || "").split(",").map((item) => item.trim().toLowerCase()).filter((item) => item.includes("@"));
  if (ids.length === 0 && emails.length === 0) return [];
  const result = await pool.query<{ id: number | string; tg_chat_id: number | string }>(
    `select id, tg_chat_id from users
      where tg_chat_id is not null and blocked_at is null
        and (id = any($1::bigint[]) or (verified_email = email and lower(coalesce(email, '')) = any($2::text[])))`,
    [ids, emails],
  );
  return result.rows.map((row) => ({ userId: Number(row.id), chatId: String(row.tg_chat_id) }));
}

export const ADMIN_ALERT_SEND_TIMEOUT_MS = 8_000;

/** HTTP success alone cannot prove a Telegram message was accepted. */
export async function sendAdminAlertMessage(input: { token: string; chatId: string; text: string; fetchImpl?: typeof fetch }) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const payload = await Promise.race([
      (input.fetchImpl ?? fetch)(`https://api.telegram.org/bot${input.token}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: input.chatId, text: input.text, parse_mode: "HTML", disable_web_page_preview: true }),
        signal: controller.signal,
      }).then(readTelegramResponse),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("telegram_delivery_unknown")); }, ADMIN_ALERT_SEND_TIMEOUT_MS);
      }),
    ]);
    return classifyTelegramDelivery(payload);
  } catch { return { kind: "unknown" as const }; }
  finally { if (timer) clearTimeout(timer); }
}

export async function deliverAdminAlerts(input: {
  pool: Pick<Pool, "query">;
  notifications: readonly StoredAdminAlertNotification[];
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  nowMs?: number;
  logger?: Pick<Console, "error" | "info">;
}): Promise<{ sent: number; failed: number; recipients: number; unknown: number; pending: number }> {
  const env = input.env ?? process.env;
  const logger = input.logger ?? console;
  const token = String(env.TG_BOT_TOKEN || "").trim();
  const botId = Number(token.match(/^([1-9]\d*):/u)?.[1]);
  const summary = { sent: 0, failed: 0, recipients: 0, unknown: 0, pending: 0 };
  if (!input.notifications.length) return summary;
  if (!Number.isSafeInteger(botId) || env.AURORA_OUTBOUND_DISABLED === "1") {
    logger.error("[admin-alerts]", { code: env.AURORA_OUTBOUND_DISABLED === "1" ? "outbound_disabled" : "telegram_not_configured" });
    return { ...summary, pending: input.notifications.length };
  }
  const recipients = [...new Map((await adminAlertRecipients(input.pool, env)).map((recipient) => [recipient.chatId, recipient])).values()];
  summary.recipients = recipients.length;
  if (!recipients.length) {
    logger.error("[admin-alerts]", { code: "no_admin_recipients" });
    return { ...summary, pending: input.notifications.length };
  }
  const ids = String(env.AURORA_ADMIN_USER_IDS || "").split(",").map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
  const emails = String(env.AURORA_ADMIN_EMAILS || "").split(",").map((email) => email.trim().toLowerCase()).filter((email) => email.includes("@"));
  const appUrl = String(env.APP_URL || env.NEXT_PUBLIC_APP_URL || "").trim() || null;
  const nowMs = input.nowMs ?? Date.now();
  const now = new Date(nowMs);
  for (const notification of input.notifications) {
    if (!Number.isSafeInteger(notification.eventId) || notification.eventId <= 0) throw new Error("admin_alert_identity_required");
    for (const recipient of recipients) {
      await input.pool.query(
        `insert into admin_alert_deliveries(notification_id,user_id,chat_id,bot_id)
         select id,$2,$3,$4 from admin_alert_notifications where id=$1 and completed_at is null and superseded_at is null
         on conflict do nothing`, [notification.eventId, recipient.userId, recipient.chatId, botId],
      );
      // A previous process may have died after dispatch. Expiration is not retry proof.
      await input.pool.query(
        `update admin_alert_deliveries set send_status='unknown',last_error_code='telegram_delivery_unknown',updated_at=$3
          where notification_id=$1 and (user_id=$2 or chat_id=$4) and send_status='sending' and sending_at <= $3::timestamptz-interval '8 seconds'`,
        [notification.eventId, recipient.userId, now, recipient.chatId],
      );
      const attempt = randomUUID();
      const claimed = await input.pool.query(
        `update admin_alert_deliveries delivery set send_status='sending',attempt_token=$5,attempts=attempts+1,sending_at=$6,updated_at=$6
          where notification_id=$1 and (user_id=$2 or chat_id=$3) and chat_id=$3 and bot_id=$4
            and send_status in ('pending','rejected') and (retry_not_before is null or retry_not_before <= $6)
            and exists(select 1 from admin_alert_notifications event where event.id=delivery.notification_id and event.completed_at is null and event.superseded_at is null)
            and exists(select 1 from users actor where actor.id=$2 and actor.tg_chat_id=$3 and actor.blocked_at is null
              and (actor.id=any($7::bigint[]) or (actor.verified_email=actor.email and lower(coalesce(actor.email,''))=any($8::text[]))))
          returning user_id`, [notification.eventId, recipient.userId, recipient.chatId, botId, attempt, now, ids, emails],
      );
      if (claimed.rowCount !== 1) {
        const status = (await input.pool.query<{ send_status: string }>("select send_status from admin_alert_deliveries where notification_id=$1 and (user_id=$2 or chat_id=$3)", [notification.eventId, recipient.userId, recipient.chatId])).rows[0]?.send_status;
        if (status === "unknown" || status === "sending") summary.unknown += 1;
        else if (status !== "sent") summary.pending += 1;
        continue;
      }
      const outcome = await sendAdminAlertMessage({ token, chatId: recipient.chatId, text: formatAdminAlertMessage(notification, appUrl, nowMs), fetchImpl: input.fetchImpl });
      const status = outcome.kind === "accepted" ? "sent" : outcome.kind === "rejected" ? "rejected" : "unknown";
      const retryAt = outcome.kind === "rejected" ? new Date(nowMs + Math.max(adminAlertsConfig(env).intervalMs, (outcome.retryAfterSeconds ?? 0) * 1000)) : null;
      const receipt = outcome.kind === "accepted" ? JSON.stringify({ messageId: outcome.messageIds[0], botId }) : null;
      try {
        const saved = await input.pool.query(
          `update admin_alert_deliveries set send_status=$4,receipt=$5::jsonb,retry_not_before=$6,last_error_code=$7,updated_at=$8
            where notification_id=$1 and user_id=$2 and attempt_token=$3 and send_status='sending'`,
          [notification.eventId, claimed.rows[0].user_id, attempt, status, receipt, retryAt, outcome.kind === "accepted" ? null : outcome.kind === "rejected" ? "telegram_rejected" : "telegram_delivery_unknown", now],
        );
        if (saved.rowCount !== 1) throw new Error("admin_alert_receipt_unconfirmed");
        if (outcome.kind === "accepted") summary.sent += 1;
        else if (outcome.kind === "rejected") summary.failed += 1;
        else summary.unknown += 1;
      } catch {
        // Leave a durable sending/unknown fence even if receipt persistence is unavailable.
        summary.unknown += 1;
      }
    }
    await input.pool.query(
      `update admin_alert_notifications event set completed_at=$3 where id=$1 and completed_at is null and superseded_at is null
         and not exists(select 1 from unnest($2::bigint[]) expected(chat_id)
           left join admin_alert_deliveries receipt on receipt.notification_id=event.id and receipt.chat_id=expected.chat_id
          where receipt.send_status is distinct from 'sent')`, [notification.eventId, recipients.map((recipient) => recipient.chatId), new Date(input.nowMs ?? Date.now())],
    );
  }
  return summary;
}
