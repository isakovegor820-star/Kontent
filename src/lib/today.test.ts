import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildTodayPulse,
  loadTodayBoard,
  nextTodayReminderAt,
  rankTodayItems,
  setTodayRecommendationPreference,
  todayPreferenceFingerprint,
  updateTodayItemState,
  type TodayItem,
} from "./today";

const item = (type: TodayItem["type"], priority: number, fingerprint: string): TodayItem => ({
  fingerprint: fingerprint.repeat(64).slice(0, 64), type, priority, title: type, whyNow: "Почему сейчас",
  channelId: 1, channelLabel: "Канал", confidence: "medium", epistemicState: "inferred", freshness: "сейчас",
  primaryAction: { label: "Открыть", href: "/app/calendar" }, secondaryAction: null, evidence: null,
  sourceLabel: "Источник",
  smartAction: null,
  recommendationKind: null,
});

describe("Today deterministic ranking", () => {
  it("ranks by server priority and stable type/fingerprint tie-breaks", () => {
    const ranked = rankTodayItems([item("result", 70, "c"), item("risk", 100, "b"), item("review", 100, "a")]);
    expect(ranked.map((entry) => entry.type)).toEqual(["risk", "review", "result"]);
  });

  it("never returns more than five decisions", () => {
    expect(rankTodayItems(Array.from({ length: 9 }, (_, index) => item("opportunity", index, String(index))))).toHaveLength(5);
  });
});

describe("Today reminder time", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses 09:00 on the next project calendar day instead of adding 24 hours", () => {
    expect(nextTodayReminderAt(
      "Europe/Amsterdam",
      new Date("2026-03-28T12:00:00.000Z"),
    )).toBe("2026-03-29T07:00:00.000Z");
  });

  it("keeps 09:00 local time across the autumn clock change", () => {
    expect(nextTodayReminderAt(
      "Europe/Amsterdam",
      new Date("2026-10-24T12:00:00.000Z"),
    )).toBe("2026-10-25T08:00:00.000Z");
  });
});

function todayDb(options: {
  failSources?: Array<"opportunities" | "reviews" | "results">;
  userState?: string;
  featureEnabled?: boolean;
  noChannels?: boolean;
  readiness?: Partial<{ competitor_count: string; opportunity_count: string; published_count: string; stats_count: string }>;
  opportunityRows?: Array<Record<string, unknown>>;
  reviewRows?: Array<Record<string, unknown>>;
  resultRows?: Array<Record<string, unknown>>;
  hiddenPreference?: boolean;
  postFrequency?: number | null;
  occupiedDates?: string[];
  completedRows?: Array<Record<string, unknown>>;
} = {}) {
  return {
    query: vi.fn(async (...args: [sql: string, values?: unknown[]]) => {
      const [sql, values = []] = args;
      if (sql.includes("user_project_preferences")) {
        return { rows: [{ project_id: "7", user_id: "9", role: "owner", version: "1" }] };
      }
      if (sql.includes("select timezone from projects")) {
        return { rows: [{ timezone: "Europe/Amsterdam" }] };
      }
      if (sql.includes("from channels channel")) {
        if (options.noChannels) return { rows: [] };
        return { rows: [
          { id: "11", title: "Первый канал", handle: "first", today_enabled: true },
          { id: "12", title: "Второй канал", handle: "second", today_enabled: false },
        ] };
      }
      if (sql.includes("select enabled from channel_feature_flags")) {
        return { rows: [{ enabled: options.featureEnabled ?? true }] };
      }
      if (sql.includes("as competitor_count")) {
        return { rows: [{
          competitor_count: "2", opportunity_count: "1", published_count: "1", stats_count: "1",
          done_today: "0", snoozed: "0", ...options.readiness,
        }] };
      }
      if (sql.includes("from opportunity_snapshots")) {
        if (options.failSources?.includes("opportunities")) throw new Error("opportunities unavailable");
        return { rows: options.opportunityRows ?? [] };
      }
      if (sql.includes("from autopilot_settings")) {
        return { rows: options.postFrequency == null ? [] : [{ post_frequency: String(options.postFrequency) }] };
      }
      if (sql.includes("select distinct local_date::text")) {
        return { rows: (options.occupiedDates ?? []).map((local_date) => ({ local_date })) };
      }
      if (sql.includes("from drafts draft")) {
        if (options.failSources?.includes("reviews")) throw new Error("reviews unavailable");
        return { rows: options.reviewRows ?? [{
          id: "81",
          version: "3",
          updated_at: "2026-08-23T08:00:00.000Z",
          editorial_state: "in_review",
          ai_validation: null,
        }] };
      }
      if (sql.includes("from posts post")) {
        if (options.failSources?.includes("results")) throw new Error("results unavailable");
        return { rows: options.resultRows ?? [] };
      }
      if (sql.includes("from today_source_refreshes")) {
        return { rows: [
          { source: "reviews", last_attempt_state: "success", last_success_at: "2026-08-23T08:00:00.000Z" },
          { source: "opportunities", last_attempt_state: "success", last_success_at: "2026-08-23T08:05:00.000Z" },
          { source: "results", last_attempt_state: "success", last_success_at: "2026-08-23T08:10:00.000Z" },
        ] };
      }
      if (sql.includes("delete from today_item_states")) {
        return { rows: [{ fingerprint: "c".repeat(64) }] };
      }
      if (sql.includes("state = 'done'") && sql.includes("item_snapshot")) {
        return { rows: options.completedRows ?? [] };
      }
      if (sql.includes("from today_item_states")) {
        const fingerprints = values[3] as string[] | undefined;
        if (options.hiddenPreference && fingerprints && fingerprints.length > 1) {
          return { rows: [{ fingerprint: fingerprints.at(-1), state: "dismissed", snoozed_until: null }] };
        }
        return { rows: options.userState && fingerprints?.[0] ? [{
          fingerprint: fingerprints[0],
          state: options.userState,
          snoozed_until: null,
        }] : [] };
      }
      if (sql.includes("insert into today_item_states")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    }),
  };
}

describe("Today board states", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("rejects a channel outside the selected project instead of falling back", async () => {
    vi.stubEnv("AURORA_RELEASE1_DEV_ENABLED", "false");
    await expect(loadTodayBoard(
      { actorUserId: 9, channelId: 999 },
      todayDb() as never,
    )).rejects.toMatchObject({ code: "channel_not_found" });
  });

  it("exposes selectable channel availability for a valid channel", async () => {
    vi.stubEnv("AURORA_RELEASE1_DEV_ENABLED", "false");
    const board = await loadTodayBoard({ actorUserId: 9, channelId: 11 }, todayDb() as never);

    expect(board.channelId).toBe(11);
    expect(board.timezone).toBe("Europe/Amsterdam");
    expect(board.channels).toEqual([
      { id: 11, label: "Первый канал", enabled: true },
      { id: 12, label: "Второй канал", enabled: false },
    ]);
    expect(board.items[0]?.secondaryAction).toEqual({
      label: "Напомнить завтра",
      state: "snoozed",
    });
  });

  it("reports total source failure instead of showing a fake empty-state action", async () => {
    vi.stubEnv("AURORA_RELEASE1_DEV_ENABLED", "false");
    const board = await loadTodayBoard(
      { actorUserId: 9, channelId: 11 },
      todayDb({ failSources: ["opportunities", "reviews", "results"] }) as never,
    );

    expect(board.availability).toBe("unavailable");
    expect(board.partialErrors).toHaveLength(3);
    expect(board.items).toEqual([]);
  });

  it("keeps working cards when only one source is unavailable", async () => {
    const board = await loadTodayBoard(
      { actorUserId: 9, channelId: 11 },
      todayDb({ failSources: ["results"] }) as never,
    );
    expect(board.availability).toBe("partial");
    expect(board.items.some((entry) => entry.type === "review")).toBe(true);
    expect(board.partialErrors).toEqual([{ source: "results", message: "Результаты временно недоступны." }]);
  });

  it("returns useful no-channel readiness without demo cards", async () => {
    const board = await loadTodayBoard({ actorUserId: 9, channelId: null }, todayDb({ noChannels: true }) as never);
    expect(board.readiness.state).toBe("no_channel");
    expect(board.items).toEqual([]);
  });

  it.each([
    [{ competitor_count: "1", opportunity_count: "0", published_count: "0", stats_count: "0" }, "need_competitors"],
    [{ competitor_count: "2", opportunity_count: "0", published_count: "0", stats_count: "0" }, "need_posts"],
    [{ competitor_count: "2", opportunity_count: "0", published_count: "1", stats_count: "0" }, "need_stats"],
    [{ competitor_count: "2", opportunity_count: "0", published_count: "1", stats_count: "1" }, "complete"],
  ] as const)("derives the %s onboarding state from real source counts", async (readiness, expected) => {
    const board = await loadTodayBoard(
      { actorUserId: 9, channelId: 11 },
      todayDb({ readiness, userState: "done" }) as never,
    );
    expect(board.readiness.state).toBe(expected);
    expect(board.items).toEqual([]);
  });

  it("turns missing prerequisites into a real daily decision for the selected channel", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
    const db = todayDb({
      reviewRows: [],
      opportunityRows: [],
      resultRows: [],
      readiness: { competitor_count: "0", opportunity_count: "0", published_count: "0", stats_count: "0" },
    });
    const board = await loadTodayBoard(
      { actorUserId: 9, channelId: 11 },
      db as never,
    );

    expect(board.readiness.state).toBe("has_items");
    expect(board.items).toEqual([expect.objectContaining({
      type: "risk",
      title: "Добавьте двух конкурентов",
      primaryAction: { label: "Добавить конкурентов", href: "/app/competitors?channel=11" },
      sourceLabel: "Готовность канала",
    })]);
    const readinessQuery = db.query.mock.calls.find(([sql]) => String(sql).includes("as competitor_count"));
    expect(String(readinessQuery?.[0])).toContain("competitor.channel_id = $2");
    expect(String(readinessQuery?.[0])).not.toContain("competitor.project_id");
    vi.useRealTimers();
  });

  it("keeps an administrator-disabled channel recoverable without loading sources", async () => {
    const board = await loadTodayBoard(
      { actorUserId: 9, channelId: 11 },
      todayDb({ featureEnabled: false }) as never,
    );
    expect(board.enabled).toBe(false);
    expect(board.readiness.state).toBe("admin_disabled");
    expect(board.items).toEqual([]);
  });

  it.each(["done", "snoozed"])("hides a card in %s state", async (userState) => {
    const board = await loadTodayBoard(
      { actorUserId: 9, channelId: 11 },
      todayDb({ userState }) as never,
    );
    expect(board.items).toEqual([]);
  });

  it("keeps an active card visible", async () => {
    const board = await loadTodayBoard(
      { actorUserId: 9, channelId: 11 },
      todayDb({ userState: "active" }) as never,
    );
    expect(board.items).toHaveLength(1);
  });

  it("keeps an explicitly dismissed card out of the active list", async () => {
    vi.stubEnv("AURORA_RELEASE1_DEV_ENABLED", "false");
    const board = await loadTodayBoard(
      { actorUserId: 9, channelId: 11 },
      todayDb({ userState: "dismissed" }) as never,
    );

    expect(board.items).toEqual([]);
  });

  it("restores a snoozed item by deleting only its user-owned state", async () => {
    vi.stubEnv("AURORA_RELEASE1_DEV_ENABLED", "false");
    const db = todayDb();
    await updateTodayItemState({
      actorUserId: 9,
      channelId: 11,
      fingerprint: "c".repeat(64),
      state: "active",
    }, db as never);

    const deleteCall = db.query.mock.calls.find(([sql]) => String(sql).includes("delete from today_item_states"));
    expect(deleteCall?.[1]).toEqual([7, 11, 9, "c".repeat(64)]);
  });

  it("persists done with the selected project, channel and user scope", async () => {
    const db = todayDb();
    const board = await loadTodayBoard({ actorUserId: 9, channelId: 11 }, db as never);
    await updateTodayItemState({
      actorUserId: 9,
      channelId: 11,
      fingerprint: board.items[0].fingerprint,
      state: "done",
    }, db as never);
    const insert = db.query.mock.calls.find(([sql]) => String(sql).includes("insert into today_item_states"));
    expect(insert?.[1]).toEqual([
      7,
      11,
      9,
      board.items[0].fingerprint,
      "today-rank-v1",
      "done",
      null,
      expect.stringContaining(`"fingerprint":"${board.items[0].fingerprint}"`),
    ]);
  });

  it("persists a dismissed decision without adding it to completed items", async () => {
    const db = todayDb();
    const board = await loadTodayBoard({ actorUserId: 9, channelId: 11 }, db as never);
    await updateTodayItemState({
      actorUserId: 9,
      channelId: 11,
      fingerprint: board.items[0].fingerprint,
      state: "dismissed",
    }, db as never);
    const insert = db.query.mock.calls.find(([sql]) => String(sql).includes("insert into today_item_states"));
    expect(insert?.[1]).toEqual([
      7,
      11,
      9,
      board.items[0].fingerprint,
      "today-rank-v1",
      "dismissed",
      null,
      null,
    ]);
  });

  it("returns completed decisions from their durable snapshots", async () => {
    const fingerprint = "d".repeat(64);
    const board = await loadTodayBoard(
      { actorUserId: 9, channelId: 11 },
      todayDb({
        completedRows: [{
          fingerprint,
          updated_at: "2026-08-23T10:15:00.000Z",
          item_snapshot: {
            fingerprint,
            type: "review",
            title: "Проверить черновик",
            whyNow: "Материал ждал решения.",
            channelLabel: "Первый канал",
            sourceLabel: "Редакционный процесс",
          },
        }],
      }) as never,
    );

    expect(board.completedItems).toEqual([expect.objectContaining({
      fingerprint,
      title: "Проверить черновик",
      completedAt: "2026-08-23T10:15:00.000Z",
    })]);
  });

  it("builds a real seven-day pulse and compares normalized results", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
    const pulse = buildTodayPulse([
      { post_id: "1", post_text: "Новый пост", stats_id: "101", draft_id: null, source_topic: "Новый пост", views: 300, reactions: 30, previous_views: null, previous_reactions: null, collected_at: "2026-08-23T10:00:00.000Z", published_at: "2026-08-23T08:00:00.000Z" },
      { post_id: "2", post_text: "Прошлый пост", stats_id: "102", draft_id: null, source_topic: "Прошлый пост", views: 100, reactions: 5, previous_views: null, previous_reactions: null, collected_at: "2026-08-16T10:00:00.000Z", published_at: "2026-08-16T08:00:00.000Z" },
    ], "Europe/Amsterdam");
    expect(pulse).toMatchObject({ state: "ready", publishedCount: 1, postsWithStats: 1, views: 300, reactions: 30 });
    expect(pulse.comparison.viewsPerPostPercent).toBe(200);
    expect(pulse.bestPost?.title).toBe("Новый пост");
    expect(pulse.series).toEqual([{ postId: 1, publishedAt: "2026-08-23T08:00:00.000Z", views: 300 }]);
    vi.useRealTimers();
  });

  it("keeps a result fingerprint stable across new stats snapshots and offers a continuation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
    const row = (statsId: string, views: number) => ([
      { post_id: "91", post_text: "Как выстроить редакционный процесс", stats_id: statsId, draft_id: "81", source_topic: "Редакционный процесс", views, reactions: 30, previous_views: null, previous_reactions: null, collected_at: "2026-08-23T10:00:00.000Z", published_at: "2026-08-22T08:00:00.000Z" },
      ...[1, 2, 3].map((id) => ({ post_id: String(id), post_text: `База ${id}`, stats_id: String(id), draft_id: null, source_topic: null, views: 100, reactions: 5, previous_views: null, previous_reactions: null, collected_at: "2026-08-20T10:00:00.000Z", published_at: `2026-08-${10 + id}T08:00:00.000Z` })),
    ]);
    const first = await loadTodayBoard({ actorUserId: 9, channelId: 11 }, todayDb({ resultRows: row("501", 160) }) as never);
    const second = await loadTodayBoard({ actorUserId: 9, channelId: 11 }, todayDb({ resultRows: row("502", 180) }) as never);
    const firstResult = first.items.find((candidate) => candidate.type === "result");
    const secondResult = second.items.find((candidate) => candidate.type === "result");
    expect(firstResult?.fingerprint).toBe(secondResult?.fingerprint);
    expect(firstResult?.primaryAction.label).toBe("Запланировать продолжение");
    expect(firstResult?.smartAction?.kind).toBe("continue_post");
    vi.useRealTimers();
  });

  it("uses a real calendar gap for the best opportunity and suppresses only that recommendation type", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
    const opportunityRows = [{
      id: "71", title: "Ответить на новый рыночный сигнал", confidence: "high", epistemic_state: "inferred",
      observed_at: "2026-08-23T09:00:00.000Z", expires_at: "2026-08-30T09:00:00.000Z", fingerprint: "source-71",
      evidence: { sourceKind: "competitor_post", sourceId: 51, sourceLabel: "Подтверждённый источник" },
      source_available: true,
    }];
    const ready = await loadTodayBoard({ actorUserId: 9, channelId: 11 }, todayDb({ opportunityRows, postFrequency: 5, occupiedDates: ["2026-08-24"] }) as never);
    const opportunity = ready.items.find((candidate) => candidate.type === "opportunity");
    expect(opportunity?.primaryAction.label).toBe("Заполнить окно");
    expect(opportunity?.smartAction).toMatchObject({ kind: "fill_calendar_gap", scheduledLocalDate: "2026-08-25" });

    const hidden = await loadTodayBoard({ actorUserId: 9, channelId: 11 }, todayDb({ opportunityRows, postFrequency: 5, hiddenPreference: true }) as never);
    expect(hidden.items.some((candidate) => candidate.type === "opportunity")).toBe(false);
    vi.useRealTimers();
  });

  it("does not offer draft creation when an opportunity source is no longer available", async () => {
    const opportunityRows = [{
      id: "71", title: "Ответить на новый рыночный сигнал", confidence: "high", epistemic_state: "inferred",
      observed_at: "2026-08-23T09:00:00.000Z", expires_at: "2026-08-30T09:00:00.000Z", fingerprint: "source-71",
      evidence: { sourceKind: "competitor_post", sourceId: 51, sourceLabel: "Удалённый источник" },
      source_available: false,
    }];
    const board = await loadTodayBoard(
      { actorUserId: 9, channelId: 11 },
      todayDb({ opportunityRows }) as never,
    );
    const opportunity = board.items.find((candidate) => candidate.type === "opportunity");

    expect(opportunity?.smartAction).toBeNull();
    expect(opportunity?.primaryAction).toEqual({
      label: "Открыть возможность",
      href: "/app/opportunities?opportunity=71&channel=11",
    });
  });

  it("stores and restores a recommendation preference inside the selected project and channel", async () => {
    const db = todayDb();
    await setTodayRecommendationPreference({ actorUserId: 9, channelId: 11, recommendationKind: "result_weak", state: "hidden" }, db as never);
    const insert = db.query.mock.calls.find(([sql]) => String(sql).includes("'dismissed'"));
    expect(insert?.[1]).toEqual([
      7, 11, 9, todayPreferenceFingerprint({ projectId: 7, channelId: 11, recommendationKind: "result_weak" }), "today-preference-v1",
    ]);
    await setTodayRecommendationPreference({ actorUserId: 9, channelId: 11, recommendationKind: "result_weak", state: "active" }, db as never);
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes("delete from today_item_states"))).toBe(true);
  });
});
