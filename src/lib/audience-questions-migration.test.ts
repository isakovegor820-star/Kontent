import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("audience questions migration", () => {
  it("creates a project-scoped editorial demand queue with immutable occurrences", async () => {
    const sql = await readFile(
      resolve(process.cwd(), "db/migrations/20260831_audience_questions.sql"),
      "utf8",
    );

    expect(sql).toMatch(/^begin;[\s\S]*commit;\s*$/u);
    expect(sql).toContain("create table if not exists audience_questions");
    expect(sql).toContain("create table if not exists audience_question_occurrences");
    expect(sql).toContain("unique (project_id, question_fingerprint)");
    expect(sql).toContain("unique (project_id, request_key)");
    expect(sql).toContain("answer_draft_id        bigint references drafts (id) on delete set null");
    expect(sql).toContain("check ((status = 'answered') = (answered_at is not null))");
  });
});
