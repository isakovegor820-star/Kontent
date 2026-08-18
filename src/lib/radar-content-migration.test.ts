import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("radar public content directory migration", () => {
  it("installs pgvector before the immutable content-directory migration", async () => {
    const prerequisiteName = "20260906_pgvector_prerequisite.sql";
    const contentDirectoryName = "20260907_radar_content_directory.sql";
    const prerequisite = await readFile(
      resolve(process.cwd(), "db/migrations", prerequisiteName),
      "utf8",
    );

    expect(prerequisiteName.localeCompare(contentDirectoryName)).toBeLessThan(0);
    expect(prerequisite).toContain("create extension if not exists vector");
  });

  it("indexes public post text and supports optional semantic retrieval", async () => {
    const sql = await readFile(
      resolve(process.cwd(), "db/migrations/20260907_radar_content_directory.sql"),
      "utf8",
    );
    expect(sql).toContain("content_sample");
    expect(sql).toContain("content_embedding vector(1024)");
    expect(sql).toContain("discovered_sources_content_tsv_idx");
    expect(sql).toContain("discovered_sources_content_embedding_idx");
    expect(sql).toContain("competitor_posts");
    expect(sql).toContain("trend_posts");
  });
});
