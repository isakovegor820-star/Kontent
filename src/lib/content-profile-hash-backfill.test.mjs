import { describe, expect, it } from "vitest";

import { contentProfileHash } from "./content-profile-hash.mjs";
import {
  LEGACY_CONTENT_PROFILE_HASH_SELECT,
  rebaseLegacyProfileHashes,
  rebaseProjectProfileHashes,
} from "./content-profile-hash-backfill.mjs";

const BRIEF_ROW = {
  channel_id: 7,
  niche: "Право",
  audience: "Собственники",
  rubrics: ["Разбор кейса"],
  formats: ["Пост"],
  author_role: "Партнёр",
  goal: "Заявки",
  cta: "Написать",
  taboo: null,
  profile_answers: { tone: "деловой" },
  quality: 82,
  ready: true,
  source: "wizard",
};

const SAVED_AT = new Date("2026-08-20T10:00:00.000Z");

function fakeClient(briefRows, { campaigns = 0, plans = 0, operations = 0 } = {}) {
  const updates = [];
  const client = {
    updates,
    query: async (sql, params) => {
      if (sql.includes("from content_brief")) {
        const rows = sql.includes("updated_at")
          ? briefRows.map((row) => ({ ...row, updated_at: SAVED_AT }))
          : briefRows.map((row) => ({ ...row }));
        return { rows };
      }
      updates.push({ sql, params });
      if (sql.includes("monthly_campaigns")) return { rowCount: campaigns };
      if (sql.includes("monthly_campaign_plans")) return { rowCount: plans };
      if (sql.includes("monthly_campaign_regeneration_operations")) return { rowCount: operations };
      return { rowCount: 0 };
    },
  };
  return client;
}

describe("legacy profile hash rebase", () => {
  it("reads the frozen legacy projection that still carried the timestamp", () => {
    expect(LEGACY_CONTENT_PROFILE_HASH_SELECT).toContain("source, updated_at");
    expect(LEGACY_CONTENT_PROFILE_HASH_SELECT).toContain("order by channel_id");
  });

  it("moves campaigns, plans and queued regenerations from the legacy digest to the current one", async () => {
    const client = fakeClient([BRIEF_ROW], { campaigns: 1, plans: 2, operations: 1 });
    const report = await rebaseProjectProfileHashes(client, 11);

    expect(report.currentHash).toBe(contentProfileHash([BRIEF_ROW]));
    expect(report.legacyHash).toBe(contentProfileHash([{ ...BRIEF_ROW, updated_at: SAVED_AT }]));
    expect(report.legacyHash).not.toBe(report.currentHash);
    expect(report).toMatchObject({ projectId: 11, campaigns: 1, plans: 2, operations: 1, skipped: false });
    for (const update of client.updates) {
      expect(update.params).toEqual([11, report.legacyHash, report.currentHash]);
    }
  });

  it("only rewrites rows that still hold the legacy digest, so real staleness survives", async () => {
    const client = fakeClient([BRIEF_ROW], { campaigns: 1, plans: 1 });
    const report = await rebaseProjectProfileHashes(client, 11);
    for (const update of client.updates) {
      expect(update.sql).toContain("= $2");
    }
    expect(client.updates.some((update) => update.sql.includes("version = version + 1"))).toBe(false);
    expect(report.skipped).toBe(false);
  });

  it("leaves finished regenerations alone", async () => {
    const client = fakeClient([BRIEF_ROW]);
    await rebaseProjectProfileHashes(client, 11);
    const operations = client.updates.find((update) => update.sql.includes("regeneration_operations"));
    expect(operations.sql).toContain("'pending', 'processing', 'retryable_failed'");
  });

  it("writes nothing for a project without briefs, where both digests already agree", async () => {
    const client = fakeClient([]);
    const report = await rebaseProjectProfileHashes(client, 12);
    expect(report.skipped).toBe(true);
    expect(client.updates).toEqual([]);
  });

  it("commits one transaction per project and reports totals", async () => {
    const statements = [];
    const client = fakeClient([BRIEF_ROW], { campaigns: 1, plans: 1 });
    const baseQuery = client.query;
    const pool = {
      query: async () => ({ rows: [{ project_id: 11 }, { project_id: 12 }] }),
      connect: async () => ({
        query: async (sql, params) => {
          statements.push(sql.trim().split("\n")[0]);
          return baseQuery(sql, params);
        },
        release: () => {},
      }),
    };

    const totals = await rebaseLegacyProfileHashes({ pool });

    expect(totals).toEqual({ projects: 2, rebased: 2, campaigns: 2, plans: 2, operations: 0 });
    expect(statements.filter((sql) => sql === "begin")).toHaveLength(2);
    expect(statements.filter((sql) => sql === "commit")).toHaveLength(2);
    expect(statements).not.toContain("rollback");
  });
});
