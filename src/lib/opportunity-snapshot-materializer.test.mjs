import { describe, expect, it, vi } from "vitest";

import {
  materializeOpportunitySnapshots,
  opportunityFingerprint,
} from "./opportunity-snapshot-materializer.mjs";

const move = {
  id: 41,
  weekStart: "2026-08-17",
  kind: "topic",
  confidence: "answered",
  title: "Напиши пост про предоплату",
  prompt: "Самостоятельный материал о порядке работы с предоплатой.",
  sourceKind: "competitor_post",
  sourceId: "91",
  fingerprint: "a".repeat(64),
  evidence: {
    sourceType: "Пост конкурента",
    sourceLabel: "Публичный канал",
    sampleSize: 3,
    opportunityStrength: 4,
    observedAt: "2026-08-20T10:00:00.000Z",
    methodology: "Наблюдение публичного источника",
  },
};

describe("opportunity snapshot materializer", () => {
  it("uses stable fingerprints and does not duplicate a replay", async () => {
    let inserted = false;
    const db = {
      query: vi.fn(async (sql) => {
        if (sql.includes("select text from posts")) return { rows: [{ text: "Согласование договора" }] };
        if (sql.includes("insert into opportunity_snapshots")) {
          const rowCount = inserted ? 0 : 1;
          inserted = true;
          return { rows: [], rowCount };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    };

    const first = await materializeOpportunitySnapshots(db, { projectId: 7, channelId: 11 }, [move]);
    const second = await materializeOpportunitySnapshots(db, { projectId: 7, channelId: 11 }, [move]);

    expect(first).toEqual({ candidates: 1, inserted: 1 });
    expect(second).toEqual({ candidates: 1, inserted: 0 });
    expect(opportunityFingerprint(move)).toBe(opportunityFingerprint({ ...move }));
    const inserts = db.query.mock.calls.filter(([query]) => query.includes("insert into opportunity_snapshots"));
    expect(inserts[0][1][3]).toBe(inserts[1][1][3]);
  });
});
