import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  resolveLibraryChannel: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("./db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("./library-server", () => ({
  resolveLibraryChannel: mocks.resolveLibraryChannel,
}));
vi.mock("./ai-engine-policy.mjs", () => ({
  configuredServiceEngine: () => "local",
  resolveAiEngineRuntime: () => ({
    id: "local",
    label: "Hermes 3",
    configured: true,
  }),
}));

import { parseLibraryFilters } from "./library-filters";
import { buildLibraryRegistrySnapshot } from "./library-registry";

const sourcePost = {
  id: "101",
  channel_id: "11",
  channel_title: "Канал",
  source_id: "21",
  source_title: "Конкурент",
  handle: "competitor",
  tg_msg_id: "501",
  text: "Сильный пост",
  views: "1200",
  reactions: "75",
  posted_at: "2026-08-26T12:00:00.000Z",
  media: "photo",
  is_hit: true,
  analytics_lift: "3.25",
  analytics_er_bayes: "0.061",
  analytics_velocity: "54.5",
  analytics_velocity_z: "2.4",
  analytics_freshness: "0.82",
  analytics_score: "93.7",
  analytics_formula_version: "persisted-v2",
  analytics_quality: "high",
  analytics_maturity: "mature",
  saved: false,
  viewed_at: null,
  rating: null,
};

describe("buildLibraryRegistrySnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveLibraryChannel.mockResolvedValue(11);
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("select title from channels")) return { rows: [{ title: "Канал" }] };
      if (sql.includes("as competitor_count")) {
        return {
          rows: [{
            competitor_count: "1",
            source_post_count: "1",
            pending_idea_count: "2",
            ai_engine: "local",
          }],
        };
      }
      if (sql.includes("from competitor_posts p") && sql.includes("join competitors c")) {
        return { rows: [sourcePost] };
      }
      if (sql.includes("from content_ideas idea") && sql.includes("select idea.id")) {
        return {
          rows: [{
            id: "301",
            source_post_id: "101",
            source_id: "21",
            topic: "Готовая идея",
            hook: "Хук",
            structure: null,
            why_it_worked: null,
            created_at: "2026-08-27T10:00:00.000Z",
            source_title: "Конкурент",
            handle: "competitor",
            tg_msg_id: "501",
            source_text: sourcePost.text,
            viewed_at: null,
            rating: null,
          }],
        };
      }
      if (sql.includes("from saved_posts saved") && sql.includes("select saved.id")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
  });

  it("reads persisted analytics and exposes pending ideas only as diagnostics", async () => {
    const snapshot = await buildLibraryRegistrySnapshot(
      7,
      parseLibraryFilters({ channel: 11 }),
    );

    expect(snapshot?.items).toHaveLength(2);
    expect(snapshot?.items.find((item) => item.kind === "reference")).toMatchObject({
      kind: "reference",
      analyticsScore: 93.7,
      lift: 3.25,
      velocity: 54.5,
      formulaVersion: "persisted-v2",
      dataQuality: "high",
      dataMaturity: "mature",
      isHit: true,
    });
    expect(snapshot?.items.find((item) => item.kind === "idea")).toMatchObject({
      kind: "idea",
      analyticsScore: 93.7,
      isHit: true,
    });
    expect(snapshot?.diagnostics).toMatchObject({
      competitorCount: 1,
      sourcePostCount: 1,
      readyIdeaCount: 1,
      pendingIdeaCount: 2,
    });

    const ideaSql = mocks.query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes("select idea.id"));
    expect(ideaSql).toContain("idea.ai_status = 'ready'");

    const sourceSql = mocks.query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes("from competitor_posts p"));
    expect(sourceSql).toContain("p.analytics_score");
  });

  it("shows a recovered topic for a legacy ready idea", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("select title from channels")) return { rows: [{ title: "Канал" }] };
      if (sql.includes("as competitor_count")) {
        return { rows: [{ competitor_count: "1", source_post_count: "1", pending_idea_count: "0", ai_engine: "local" }] };
      }
      if (sql.includes("from competitor_posts p") && sql.includes("join competitors c")) {
        return { rows: [{ ...sourcePost, text: "Нейроюрист работает прямо в Microsoft Word.\n\nВторой абзац." }] };
      }
      if (sql.includes("from content_ideas idea") && sql.includes("select idea.id")) {
        return { rows: [{
          id: "302", source_post_id: "101", source_id: "21", topic: null, hook: "Хук",
          structure: null, why_it_worked: null, created_at: "2026-08-27T10:00:00.000Z",
          source_title: "Конкурент", handle: "competitor", tg_msg_id: "501",
          source_text: "Нейроюрист работает прямо в Microsoft Word.\n\nВторой абзац.",
          viewed_at: null, rating: null,
        }] };
      }
      if (sql.includes("from saved_posts saved") && sql.includes("select saved.id")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    const snapshot = await buildLibraryRegistrySnapshot(7, parseLibraryFilters({ channel: 11 }));
    expect(snapshot?.items.find((item) => item.kind === "idea")).toMatchObject({
      text: expect.stringMatching(/^Нейроюрист работает/u),
      idea: { topic: "Нейроюрист работает прямо в Microsoft Word." },
    });
  });
});
