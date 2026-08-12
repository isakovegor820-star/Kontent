import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("legacy media generation timestamp baseline", () => {
  it("runs before project-scoped media indexes and mirrors bootstrap", async () => {
    const migration = await readFile(
      resolve(process.cwd(), "db/migrations/20260817_legacy_media_generations_baseline.sql"),
      "utf8",
    );
    const legalVisual = await readFile(
      resolve(process.cwd(), "db/migrations/20260817_legal_visuals.sql"),
      "utf8",
    );
    const bootstrap = await readFile(resolve(process.cwd(), "db/schema.sql"), "utf8");

    expect(migration).toMatch(/^begin;[\s\S]*commit;\s*$/u);
    expect(migration).toContain(
      "add column if not exists created_at timestamptz not null default now()",
    );
    expect(migration).toContain("add column if not exists output_asset_id bigint");
    expect(migration).toContain("alter table users");
    expect(migration).toContain("add column if not exists avatar text");
    expect(migration).toContain("add column if not exists reactions integer");
    expect(migration).toContain("alter column prompt set not null");
    expect(migration).toContain("legacy_request_unavailable");
    expect(legalVisual).toContain("media_generations_project_created_idx");
    expect(bootstrap).toContain(
      "alter table media_generations add column if not exists created_at timestamptz not null default now()",
    );
  });
});
