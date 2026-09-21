import type { Pool } from "pg";

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

type TrackedState = { firing: boolean; sinceMs: number; lastNotifiedAt: number | null };

/**
 * Turns condition snapshots into notifications: one on the transition into failure,
 * a reminder every `repeatMs` while it persists, one on recovery. The first observation
 * of a healthy component is silent.
 */
export class AdminAlertTracker {
  readonly #states = new Map<AdminAlertId, TrackedState>();
  readonly #repeatMs: number;

  constructor(options: { repeatMs?: number } = {}) {
    this.#repeatMs = options.repeatMs ?? ADMIN_ALERT_DEFAULTS.repeatMs;
  }

  transition(conditions: readonly AdminAlertCondition[], nowMs = Date.now()): AdminAlertNotification[] {
    const notifications: AdminAlertNotification[] = [];
    for (const condition of conditions) {
      const previous = this.#states.get(condition.id);
      if (condition.firing) {
        if (!previous?.firing) {
          this.#states.set(condition.id, { firing: true, sinceMs: nowMs, lastNotifiedAt: nowMs });
          notifications.push({ id: condition.id, kind: "fired", severity: condition.severity, detail: condition.detail, sinceMs: nowMs });
        } else if (nowMs - (previous.lastNotifiedAt ?? previous.sinceMs) >= this.#repeatMs) {
          previous.lastNotifiedAt = nowMs;
          notifications.push({ id: condition.id, kind: "still_firing", severity: condition.severity, detail: condition.detail, sinceMs: previous.sinceMs });
        }
      } else {
        if (previous?.firing) {
          notifications.push({ id: condition.id, kind: "recovered", severity: condition.severity, detail: condition.detail, sinceMs: previous.sinceMs });
        }
        this.#states.set(condition.id, { firing: false, sinceMs: nowMs, lastNotifiedAt: null });
      }
    }
    return notifications;
  }

  snapshot(): Array<{ id: AdminAlertId; firing: boolean; sinceMs: number }> {
    return [...this.#states.entries()].map(([id, state]) => ({ id, firing: state.firing, sinceMs: state.sinceMs }));
  }
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
        and (id = any($1::bigint[]) or lower(coalesce(email, '')) = any($2::text[]))`,
    [ids, emails],
  );
  return result.rows.map((row) => ({ userId: Number(row.id), chatId: String(row.tg_chat_id) }));
}

export async function deliverAdminAlerts(input: {
  pool: Pick<Pool, "query">;
  notifications: readonly AdminAlertNotification[];
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  nowMs?: number;
  logger?: Pick<Console, "error" | "info">;
}): Promise<{ sent: number; failed: number; recipients: number }> {
  const env = input.env ?? process.env;
  const logger = input.logger ?? console;
  const token = String(env.TG_BOT_TOKEN || "").trim();
  if (input.notifications.length === 0) return { sent: 0, failed: 0, recipients: 0 };
  if (!token) {
    logger.error("[admin-alerts]", { code: "telegram_not_configured", pending: input.notifications.map((item) => item.id) });
    return { sent: 0, failed: input.notifications.length, recipients: 0 };
  }
  const recipients = await adminAlertRecipients(input.pool, env);
  if (recipients.length === 0) {
    logger.error("[admin-alerts]", { code: "no_admin_recipients", pending: input.notifications.map((item) => item.id) });
    return { sent: 0, failed: input.notifications.length, recipients: 0 };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const appUrl = String(env.APP_URL || env.NEXT_PUBLIC_APP_URL || "").trim() || null;
  let sent = 0;
  let failed = 0;
  for (const notification of input.notifications) {
    const text = formatAdminAlertMessage(notification, appUrl, input.nowMs);
    for (const recipient of recipients) {
      try {
        const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: recipient.chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
          signal: AbortSignal.timeout(8_000),
        });
        if (response.ok) sent += 1;
        else {
          failed += 1;
          logger.error("[admin-alerts]", { code: "telegram_send_failed", status: response.status, alert: notification.id, userId: recipient.userId });
        }
      } catch (error) {
        failed += 1;
        logger.error("[admin-alerts]", { code: "telegram_send_error", errorName: error instanceof Error ? error.name : "Error", alert: notification.id, userId: recipient.userId });
      }
    }
  }
  return { sent, failed, recipients: recipients.length };
}
