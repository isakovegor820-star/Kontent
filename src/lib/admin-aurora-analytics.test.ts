import { describe, expect, it, vi } from "vitest";

import {
  AdminAnalyticsQueryError,
  loadAdminAuroraAnalytics,
  normalizeAdminAnalyticsQuery,
  rankAuroraAnalyticsProblems,
  sentryIssueSearchUrl,
  type AuroraAnalyticsSectionCard,
} from "./admin-aurora-analytics";

describe("normalizeAdminAnalyticsQuery", () => {
  const now = new Date("2026-08-30T12:00:00.000Z");

  it("normalizes bounded presets, detail URL state and safe filters", () => {
    const filters = normalizeAdminAnalyticsQuery(new URLSearchParams({
      range: "24h",
      project: "42",
      segment: "owners",
      tenure: "returning",
      device: "mobile",
      version: "web-2026.08.30",
      release: "prod-105",
      analyticsSection: "studio",
      analyticsTab: "speed",
    }), now);
    expect(filters).toMatchObject({
      range: "24h",
      from: "2026-08-29T12:00:00.000Z",
      to: "2026-08-30T12:00:00.000Z",
      previousFrom: "2026-08-28T12:00:00.000Z",
      projectId: 42,
      sectionId: "studio",
      tab: "speed",
    });
  });

  it("rejects unknown dimensions, future dates and oversized custom windows", () => {
    expect(() => normalizeAdminAnalyticsQuery(new URLSearchParams({ analyticsSection: "competitors" }), now))
      .toThrowError(new AdminAnalyticsQueryError("analytics_section_invalid"));
    expect(() => normalizeAdminAnalyticsQuery(new URLSearchParams({ device: "phone" }), now))
      .toThrowError(new AdminAnalyticsQueryError("analytics_device_invalid"));
    expect(() => normalizeAdminAnalyticsQuery(new URLSearchParams({
      range: "custom", from: "2026-01-01", to: "2026-08-30",
    }), now)).toThrowError(new AdminAnalyticsQueryError("analytics_range_out_of_bounds"));
    expect(() => normalizeAdminAnalyticsQuery(new URLSearchParams({
      range: "custom", from: "2026-08-29", to: "2026-09-30",
    }), now)).toThrowError(new AdminAnalyticsQueryError("analytics_future_range"));
  });

  it("rejects SQL-like and content-like free-form filter values", () => {
    expect(() => normalizeAdminAnalyticsQuery(new URLSearchParams({ release: "x' OR 1=1 --" }), now))
      .toThrowError(new AdminAnalyticsQueryError("analytics_release_invalid"));
  });
});

describe("loadAdminAuroraAnalytics", () => {
  it("uses a fixed tenant predicate and returns all 15 real sections without fabricated observations", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      void params;
      if (sql.includes("admin_aurora_options")) return { rows: [{ kind: "project", id: "42", label: "Проект" }] };
      return { rows: [] };
    });
    const filters = normalizeAdminAnalyticsQuery(new URLSearchParams({ project: "42" }), new Date("2026-08-30T12:00:00.000Z"));
    const result = await loadAdminAuroraAnalytics({ query } as never, filters, { now: new Date("2026-08-30T12:00:00.000Z") });

    expect(result.sections).toHaveLength(15);
    expect(result.sections.every((section) => section.technical.state === "unobserved")).toBe(true);
    expect(result.sections.every((section) => section.activity.launches.current === 0)).toBe(true);
    const metricsCall = query.mock.calls.find(([sql]) => String(sql).includes("admin_aurora_section_metrics"));
    const domainCall = query.mock.calls.find(([sql]) => String(sql).includes("admin_aurora_domain_outcomes"));
    expect(String(metricsCall?.[0])).toContain("event.project_id = $5::bigint");
    expect(metricsCall?.[1]?.[4]).toBe(42);
    expect(String(domainCall?.[0])).toContain("event.project_id = $5::bigint");
    expect(domainCall?.[1]?.[4]).toBe(42);
  });

  it("does not mislabel an unfilterable domain result when release is selected", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      void params;
      if (sql.includes("admin_aurora_section_metrics")) return { rows: [{
        section_id: "today", period: "current", unique_users: "1", sessions: "1", launches: "1",
        key_actions: "1", successes: "1", failures: "0", affected_users: "0", observations: "1",
        p50_ms: "100", p95_ms: "120000", p99_ms: "125000", page_p95_ms: "120",
        time_to_result_p50_ms: "850", last_success_at: "2026-08-30T10:00:00.000Z",
      }] };
      return { rows: [] };
    });
    const filters = normalizeAdminAnalyticsQuery(new URLSearchParams({ release: "prod-105" }), new Date("2026-08-30T12:00:00.000Z"));
    const result = await loadAdminAuroraAnalytics({ query } as never, filters, { now: new Date("2026-08-30T12:00:00.000Z") });
    expect(result.sections[0].technical.state).toBe("healthy");
    expect(result.sections[0].technical.p95Ms.current).toBe(120_000);
    expect(result.sections[0].technical.pageP95Ms).toBe(120);
    expect(result.sections[0].outcome.timeToResultP50Ms.current).toBe(850);
    expect(result.sections[0].outcome.coverage).toBe("not_filterable");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("admin_aurora_domain_outcomes"))).toBe(false);
  });
});

describe("problem ranking and Sentry links", () => {
  it("ranks by the transparent affectedUsers × frequency × severity formula", () => {
    const section = {
      id: "studio", label: "Студия контента", href: "/app/studio", groupId: "work", groupTitle: "Работа",
      activity: { uniqueUsers: { current: 4, previous: 4, changePercent: 0 }, sessions: { current: 0, previous: 0, changePercent: 0 }, launches: { current: 2, previous: 2, changePercent: 0 }, keyActions: { current: 10, previous: 10, changePercent: 0 } },
      technical: { state: "degraded", errorRate: { current: 20, previous: 2, changePercent: 900 }, affectedUsers: { current: 4, previous: 1, changePercent: 300 }, p50Ms: { current: 0, previous: 0, changePercent: 0 }, p95Ms: { current: 0, previous: 0, changePercent: 0 }, p99Ms: { current: 0, previous: 0, changePercent: 0 }, pageP95Ms: null, observations: 0, reason: "errors" },
      outcome: { coverage: "unobserved", label: "Результаты", attempts: { current: 0, previous: 0, changePercent: 0 }, attemptUsers: { current: 0, previous: 0, changePercent: 0 }, successes: { current: 0, previous: 0, changePercent: 0 }, failures: { current: 0, previous: 0, changePercent: 0 }, uniqueUsers: { current: 0, previous: 0, changePercent: 0 }, successRate: { current: 0, previous: 0, changePercent: 0 }, timeToResultP50Ms: { current: null, previous: null, changePercent: null }, lastSuccessAt: null, reason: null },
      dependencies: ["web_api", "aurora_ai"],
    } satisfies AuroraAnalyticsSectionCard;
    const problems = rankAuroraAnalyticsProblems([section], [{
      errorCode: "provider_timeout", title: "provider timeout", sectionId: "studio", featureId: "generation",
      stage: "failed", source: "api", count: 5, previousCount: 1, affectedUsers: 4, affectedProjects: 2,
      firstSeenAt: "2026-08-30T10:00:00.000Z", lastSeenAt: "2026-08-30T11:00:00.000Z", release: "prod-105",
      requestId: "req-1", status: "regression", sentryUrl: null, dependencyId: "aurora_ai",
    }]);
    expect(problems[0]).toMatchObject({ impact: 80, formula: "4 × 10 × 2 = 80", kind: "stale" });
    expect(problems.find((problem) => problem.id === "error:studio:provider_timeout:failed:api"))
      .toMatchObject({ impact: 60, formula: "4 × 5 × 3 = 60", kind: "provider_failure" });
  });

  it("ranks a latest non-terminal operation as a stuck-stage problem", () => {
    const base = {
      id: "studio", label: "Студия контента", href: "/app/studio", groupId: "work", groupTitle: "Работа",
      activity: { uniqueUsers: { current: 2, previous: 2, changePercent: 0 }, sessions: { current: 2, previous: 2, changePercent: 0 }, launches: { current: 2, previous: 2, changePercent: 0 }, keyActions: { current: 2, previous: 2, changePercent: 0 } },
      technical: { state: "healthy", errorRate: { current: 0, previous: 0, changePercent: 0 }, affectedUsers: { current: 0, previous: 0, changePercent: 0 }, p50Ms: { current: 100, previous: 100, changePercent: 0 }, p95Ms: { current: 200, previous: 200, changePercent: 0 }, p99Ms: { current: 250, previous: 250, changePercent: 0 }, pageP95Ms: 200, observations: 4, reason: "ok" },
      outcome: { coverage: "available", label: "Результаты", attempts: { current: 2, previous: 2, changePercent: 0 }, attemptUsers: { current: 2, previous: 2, changePercent: 0 }, successes: { current: 2, previous: 2, changePercent: 0 }, failures: { current: 0, previous: 0, changePercent: 0 }, uniqueUsers: { current: 2, previous: 2, changePercent: 0 }, successRate: { current: 100, previous: 100, changePercent: 0 }, timeToResultP50Ms: { current: 500, previous: 550, changePercent: -9.09 }, lastSuccessAt: "2026-08-30T11:00:00.000Z", reason: null },
      dependencies: ["web_api", "aurora_ai"],
    } satisfies AuroraAnalyticsSectionCard;
    const problems = rankAuroraAnalyticsProblems([base], [], [{
      section_id: "studio", feature_id: "generation", stage: "processing", source: "worker",
      operations: "3", affected_users: "2", oldest_age_ms: String(70 * 60_000),
    }]);
    expect(problems[0]).toMatchObject({ kind: "stuck_stage", impact: 18, dependencyId: "redis" });
  });

  it("constructs a Sentry search only from validated server configuration", () => {
    expect(sentryIssueSearchUrl("provider_timeout", { SENTRY_ORG_SLUG: "aurora-prod", SENTRY_PROJECT_ID: "123" }))
      .toBe("https://sentry.io/organizations/aurora-prod/issues/?project=123&query=is%3Aunresolved+provider_timeout");
    expect(sentryIssueSearchUrl("provider_timeout", { SENTRY_ORG_SLUG: "https://evil", SENTRY_PROJECT_ID: "123" })).toBeNull();
  });
});
