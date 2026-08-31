import { describe, expect, it, vi } from "vitest";

import {
  RECON_CRON_PATTERN,
  RECON_REFRESH_HOURS,
  selectDueCompetitorSources,
} from "./reconnaissance-schedule.mjs";

describe("reconnaissance schedule", () => {
  it("selects every due supported source across channels without a result limit", async () => {
    const sources = [
      { id: 1, channel_id: 11, network: "tg", is_active: true },
      { id: 2, channel_id: 22, network: "tg", is_active: true },
      { id: 3, channel_id: 33, network: "instagram", is_active: true },
    ];
    const query = vi.fn(async () => ({ rows: sources }));

    await expect(selectDueCompetitorSources({ query })).resolves.toEqual(sources);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("network in ('tg','instagram') and is_active");
    expect(sql).toContain("collected_at < now() - interval '2 hours'");
    expect(sql).not.toMatch(/\blimit\b/iu);
    expect(sql).not.toMatch(/channel_id\s*=\s*\$/iu);
  });

  it("runs a complete pass every two hours", () => {
    expect(RECON_REFRESH_HOURS).toBe(2);
    expect(RECON_CRON_PATTERN).toBe("0 */2 * * *");
  });
});
