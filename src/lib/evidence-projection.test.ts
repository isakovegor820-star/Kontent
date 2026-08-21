import { describe, expect, it } from "vitest";

import { loadEvidenceProjection } from "./evidence-projection";

describe("Evidence projection", () => {
  it("keeps opportunity originality not_checked instead of inventing a pass", async () => {
    const db = { query: async (sql: string) => {
      if (sql.includes("from user_project_preferences")) return { rows: [{ project_id: 7, user_id: 3, role: "owner", version: 1 }] };
      return { rows: [{ id: 9, revision: 1, title: "Свободная тема", confidence: "medium", epistemic_state: "inferred",
        formula_version: "opportunity-baseline-v1", evidence: { sourceLabel: "Источник", metricLabel: "3 подтверждённых сигнала", methodology: "Сравнение с каналом" },
        observed_at: "2026-08-21T08:00:00.000Z", expires_at: "2099-08-28T08:00:00.000Z", fingerprint: "a".repeat(64) }] };
    } };
    const projection = await loadEvidenceProjection({ actorUserId: 3, kind: "opportunity", id: 9 }, db as never);
    expect(projection.status).toBe("passed");
    expect(projection.originality.status).toBe("not_checked");
    expect(projection.anomaly.formulaVersion).toBe("opportunity-baseline-v1");
  });
});
