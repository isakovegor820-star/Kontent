import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadTodayBoard,
  nextTodayReminderAt,
  rankTodayItems,
  updateTodayItemState,
  type TodayItem,
} from "./today";

const item = (type: TodayItem["type"], priority: number, fingerprint: string): TodayItem => ({
  fingerprint: fingerprint.repeat(64).slice(0, 64), type, priority, title: type, whyNow: "Почему сейчас",
  channelId: 1, channelLabel: "Канал", confidence: "medium", epistemicState: "inferred", freshness: "сейчас",
  primaryAction: { label: "Открыть", href: "/app/calendar" }, secondaryAction: null, evidence: null,
  sourceLabel: "Источник",
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
        return { rows: [] };
      }
      if (sql.includes("from drafts draft")) {
        if (options.failSources?.includes("reviews")) throw new Error("reviews unavailable");
        return { rows: [{
          id: "81",
          version: "3",
          updated_at: "2026-08-23T08:00:00.000Z",
          editorial_state: "in_review",
          ai_validation: null,
        }] };
      }
      if (sql.includes("from posts post")) {
        if (options.failSources?.includes("results")) throw new Error("results unavailable");
        return { rows: [] };
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
      if (sql.includes("from today_item_states")) {
        const fingerprints = values[3] as string[] | undefined;
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

  it("does not keep legacy dismissed cards hidden forever", async () => {
    vi.stubEnv("AURORA_RELEASE1_DEV_ENABLED", "false");
    const board = await loadTodayBoard(
      { actorUserId: 9, channelId: 11 },
      todayDb({ userState: "dismissed" }) as never,
    );

    expect(board.items).toHaveLength(1);
    expect(board.items[0]?.type).toBe("review");
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
    expect(insert?.[1]).toEqual([7, 11, 9, board.items[0].fingerprint, "today-rank-v1", "done", null]);
  });
});
