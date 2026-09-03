import type { AdminAuroraAnalytics, AuroraMetricValue } from "@/lib/admin-aurora-analytics";
import type { AdminBotData } from "@/lib/admin-bot";
import type { AdminDashboardData } from "@/lib/admin-dashboard";
import type { AdminDiagnosticComponent, AdminSystemDiagnostics } from "@/lib/admin-system-diagnostics";

const NOW = new Date("2026-09-03T10:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();
const HOUR = 3_600_000;

export function overviewPayload(overrides: Partial<AdminDashboardData> = {}): AdminDashboardData {
  return {
    checkedAt: iso(0),
    periodDays: 7,
    summary: { usersTotal: 148, activeUsers: 37, newUsers: 11, projectsTotal: 96, publicationsTotal: 4312, publishedToday: 23, scheduled: 61, failed: 2, quarantined: 0, overdue: 1, authAttention: 1, aiToday: 58, aiPeriod: 412 },
    daily: Array.from({ length: 7 }, (_, index) => ({ date: iso((6 - index) * 24 * HOUR).slice(0, 10), registrations: index, publications: 10 + index, published: 8 + index, ai: 5 })),
    providers: [
      { network: "tg", total: 88, active: 86, attention: 1, lastAuthErrorAt: iso(3 * HOUR) },
      { network: "vk", total: 41, active: 41, attention: 0, lastAuthErrorAt: null },
    ],
    attention: [
      { id: 4311, project: "Клиника", projectId: 15, author: "Марина", authorId: 100, channel: "Клиника TG", network: "tg", status: "failed", attempts: 3, errorCode: "telegram_message_too_long", text: "Открыли запись на приём", scheduledAt: iso(2 * HOUR), createdAt: iso(26 * HOUR) },
      { id: 4309, project: "Brew", projectId: 14, author: "Аня", authorId: 102, channel: "Brew TG", network: "tg", status: "overdue", attempts: 0, errorCode: "publication_overdue", text: "Доброе утро!", scheduledAt: iso(14 * 60_000), createdAt: iso(24 * HOUR) },
    ],
    recentUsers: [],
    audit: [],
    system: { database: "up", redis: "up", publicationWorker: "up", ai: "healthy" },
    ...overrides,
  };
}

export function botPayload(overrides: Partial<AdminBotData> = {}): AdminBotData {
  return {
    periodDays: 7,
    checkedAt: iso(0),
    runtime: { state: "healthy", configured: true, botName: "Аврора", username: "aurora_bot", botId: "1", miniAppReady: true, voiceReady: true, voiceProvider: "openai", webhookClear: true, webhookGuarded: true, commandsReady: true, businessReady: false, checkedAt: iso(0) },
    workerState: "up",
    publicationWorkerState: "up",
    summary: { linkedUsers: 64, disabledUsers: 1, activeProjects: 58, disabledProjects: 0, draftsCreated: 31, publicationsScheduled: 19, publicationsPublished: 16, deliveryFailures: 2, telegramChannelsReady: 84, telegramChannelsAttention: 0, pendingResults: 7, businessConnected: 3, businessEnabled: 1, openClientInquiries: 2, interactions: 612, activeUsers: 29, commandInteractions: 140, buttonInteractions: 388, messageInteractions: 84, lastInteractionAt: iso(6 * 60_000) },
    daily: Array.from({ length: 7 }, (_, index) => ({ date: iso((6 - index) * 24 * HOUR).slice(0, 10), drafts: index % 3, scheduled: 1, published: 1, failures: index === 3 ? 2 : 0, interactions: 60 + index })),
    notifications: { recipients: 71, publicationSuccess: 66, publicationFailure: 70, opportunities: 40, postResults: 55, reviewReminders: 30, problemDigest: 61, dailyDigest: 22, weeklyDigest: 48 },
    usersPagination: { page: 1, pageSize: 20, total: 2, pages: 1 },
    users: [
      { id: 100, name: "Марина Соколова", email: "marina@example.com", linked: true, enabled: true, disabledReason: null, projects: 1, notificationProfiles: 1, draftsCreated: 2, publicationsScheduled: 1, interactions: 20, commands: 5, buttons: 10, messages: 3, lastActivityAt: iso(HOUR), lastInteractionAt: iso(HOUR), lastDeliveryAt: iso(HOUR), lastDeliveryOk: true },
      { id: 106, name: "Елена Морозова", email: null, linked: true, enabled: false, disabledReason: "Приостановлено администратором", projects: 1, notificationProfiles: 1, draftsCreated: 0, publicationsScheduled: 0, interactions: 4, commands: 1, buttons: 2, messages: 1, lastActivityAt: null, lastInteractionAt: iso(5 * HOUR), lastDeliveryAt: null, lastDeliveryOk: null },
    ],
    projects: [
      { id: 12, name: "FitLab", enabled: true, disabledReason: null, linkedMembers: 2, telegramChannels: 1, draftsCreated: 9, publicationsScheduled: 6, interactions: 140, businessConnected: true, businessEnabled: true, openClientInquiries: 2, lastActivityAt: iso(2 * HOUR) },
    ],
    deliveries: [{ id: 500, user: "Марина Соколова", project: null, method: "sendMessage", source: "assistant", ok: true, errorCode: null, description: null, createdAt: iso(HOUR) }],
    topActions: [{ type: "reply_button", action: "today", count: 140 }],
    interactions: [{ id: 800, user: "Марина Соколова", project: "FitLab", type: "reply_button", action: "today", createdAt: iso(25 * 60_000) }],
    audit: [{ id: "bot-1", action: "bot.access.disabled", target: "Елена Морозова", actor: "admin@aurora.ru", createdAt: iso(3 * HOUR) }],
    ...overrides,
  };
}

function component(id: string, group: AdminDiagnosticComponent["group"], label: string, state: AdminDiagnosticComponent["state"], extra: Partial<AdminDiagnosticComponent> = {}): AdminDiagnosticComponent {
  return {
    id, group, label, description: `${label} · описание`, state, checkedAt: iso(20_000), durationMs: 12,
    evidence: [{ label: "Проверка", value: state === "healthy" ? "Успешно" : "Нет подтверждения", tone: state === "healthy" ? "positive" : "critical" }],
    safeErrorCode: state === "healthy" || state === "configured" ? null : `${id}_probe_failed`,
    lastSuccessAt: state === "healthy" ? iso(20_000) : null,
    ...extra,
  };
}

export function systemPayload(): AdminSystemDiagnostics {
  const components: AdminDiagnosticComponent[] = [
    component("web_api", "core", "Web/API", "healthy"),
    component("postgresql", "core", "PostgreSQL", "healthy"),
    component("database_schema", "core", "Схема базы", "healthy"),
    component("redis", "core", "Redis", "degraded", { metrics: { pingLatencyMs: 3, usedMemoryBytes: 48_120_000, uptimeSeconds: 812_000, connectedClients: 14 }, queues: [{ name: "stats", state: "degraded", workers: 1, waiting: 3, active: 1, delayed: 5, completed: 1290, failed: 14, oldestJobAgeMs: 640_000, safeErrorCode: null }] }),
    component("publication_worker", "core", "Воркер публикаций", "healthy", { affectedSections: ["calendar", "composer"] }),
    component("telegram_worker", "integrations", "Telegram-воркер", "healthy"),
    component("aurora_ai", "integrations", "Aurora AI", "unobserved"),
    component("media_generation", "integrations", "Генерация медиа", "healthy"),
    component("site_analysis", "integrations", "Анализ сайтов", "healthy"),
    component("mail_delivery", "integrations", "Почтовая доставка", "healthy"),
    component("token_encryption", "security", "Шифрование токенов", "healthy"),
    component("tracking_secrets", "security", "Tracking secrets", "configured"),
    component("upload_limits", "security", "Ограничения загрузки", "configured"),
    component("https_origin", "security", "HTTPS/origin", "configured"),
    component("current_release", "security", "Текущий релиз", "healthy"),
  ];
  return {
    schemaVersion: 1, checkedAt: iso(20_000), durationMs: 640, state: "degraded",
    summary: { total: 15, healthy: 10, configured: 3, warnings: 2, critical: 0 },
    release: { release: "2026.09.02-abc", commitSha: "abcdef1234567890", deployedAt: iso(30 * HOUR) },
    components,
  };
}

const metric = (current: number, previous: number): AuroraMetricValue => ({ current, previous, changePercent: previous === 0 ? null : Math.round(((current - previous) / previous) * 1000) / 10 });

export function analyticsPayload(params: URLSearchParams): AdminAuroraAnalytics {
  const sectionId = params.get("analyticsSection") as AdminAuroraAnalytics["filters"]["sectionId"];
  const sections = ([["today", "Сегодня"], ["calendar", "Календарь"], ["autopilot", "Автопилот"]] as const).map(([id, label], index) => ({
    id, label, href: `/app/${id}`, groupId: "work", groupTitle: "Работа",
    activity: { uniqueUsers: metric(10 + index, 9), sessions: metric(30, 28), launches: metric(60, 55), keyActions: metric(20, 22) },
    technical: { state: id === "autopilot" ? "degraded" as const : "healthy" as const, errorRate: metric(id === "autopilot" ? 6.2 : 0.8, 1.1), affectedUsers: metric(0, 1), p50Ms: metric(320, 300), p95Ms: metric(1200, 1100), p99Ms: metric(2400, 2200), pageP95Ms: 1800, observations: 400, reason: "в пределах SLO" },
    outcome: { coverage: "available" as const, label: "Результат", attempts: metric(50, 48), attemptUsers: metric(12, 11), successes: metric(44, 40), failures: metric(2, 3), uniqueUsers: metric(11, 10), successRate: metric(91.5, 89.2), timeToResultP50Ms: { current: 4200, previous: 3900, changePercent: 7.7 }, lastSuccessAt: iso(40 * 60_000), reason: null },
    dependencies: ["web_api", "postgresql"],
  }));
  return {
    schemaVersion: 1, checkedAt: iso(0),
    filters: { range: "7d", from: iso(7 * 24 * HOUR), to: iso(0), previousFrom: iso(14 * 24 * HOUR), previousTo: iso(7 * 24 * HOUR), projectId: null, segment: "all", tenure: "all", device: "all", appVersion: null, release: null, sectionId: sectionId ?? null, tab: "overview" },
    rawRetentionDays: 90,
    coverage: { rawFrom: iso(21 * 24 * HOUR), domainFiltersApplied: false, notes: ["Сырые события хранятся 90 дней."] },
    options: { projects: [], releases: [], appVersions: [] },
    releases: [],
    timeline: [],
    sections,
    problems: [{ id: "p1", kind: "error_growth", title: "Автопилот: рост ошибок ai_provider_timeout", sectionId: "autopilot", affectedUsers: 4, frequency: 9, severity: 3, impact: 108, formula: "4 × 9 × 3 = 108", evidence: "9 ошибок за период против 2.", dependencyId: "aurora_ai", sentryUrl: null }],
    detail: sectionId ? { sectionId, tab: "overview", scenario: ["planned", "generated"], slos: [], funnel: [], errors: [], speed: [], events: [] } : null,
  };
}

/** Minimal `fetch` stand-in routing admin API paths to fixtures; unknown paths return 404. */
export function adminFetchMock(handlers: Record<string, (params: URLSearchParams, init?: RequestInit) => unknown | { status: number; body?: unknown }>) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    const handler = handlers[url.pathname];
    if (!handler) return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    const result = handler(url.searchParams, init);
    if (result && typeof result === "object" && "status" in result && typeof (result as { status: unknown }).status === "number") {
      const typed = result as { status: number; body?: unknown };
      return new Response(JSON.stringify(typed.body ?? {}), { status: typed.status, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
  };
}
