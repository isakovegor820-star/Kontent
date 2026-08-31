import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  CONTENT_PROFILE_HASH_SELECT,
  contentProfileHash,
  readContentProfileHash,
} from "./content-profile-hash.mjs";

describe("project content profile hash", () => {
  it("never reads a timestamp, so re-saving an unchanged brief keeps campaigns valid", () => {
    expect(CONTENT_PROFILE_HASH_SELECT).not.toContain("updated_at");
    expect(CONTENT_PROFILE_HASH_SELECT).toContain("from content_brief");
    expect(CONTENT_PROFILE_HASH_SELECT).toContain("order by channel_id");
  });

  it("changes only when a brief answer changes", () => {
    const profile = { channel_id: 7, niche: "Право", audience: "Собственники", ready: true };
    expect(contentProfileHash([profile])).toBe(contentProfileHash([{ ...profile }]));
    expect(contentProfileHash([profile])).not.toBe(
      contentProfileHash([{ ...profile, audience: "Юристы" }]),
    );
  });

  it("treats a project without profiles as an empty digest", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(readContentProfileHash({ query }, 11)).resolves.toBe(contentProfileHash([]));
    expect(query).toHaveBeenCalledWith(CONTENT_PROFILE_HASH_SELECT, [11]);
  });

  it("is the single source shared by the app and both workers", () => {
    const readers = [
      "src/lib/monthly-campaign-service.ts",
      "worker/monthly-campaign-regeneration.mjs",
      "worker.mjs",
    ];
    for (const path of readers) {
      const source = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
      expect(source).toContain("content-profile-hash.mjs");
      expect(source).not.toContain("profile_answers, quality, ready, source, updated_at");
    }
  });
});
