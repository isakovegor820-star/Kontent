import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  completeOnboarding,
  OnboardingProgressError,
  saveOnboardingProgress,
} from "./onboarding-progress";

const membership = {
  project_id: 7,
  user_id: 17,
  role: "owner",
  version: 1,
};

function progressRow(overrides: Record<string, unknown> = {}) {
  return {
    project_id: 7,
    step: 5,
    channel_id: 11,
    first_draft_id: null,
    skipped_first_source: false,
    version: 4,
    completed_at: null,
    updated_at: "2026-08-01T11:00:00.000Z",
    ...overrides,
  };
}

function database(handler: (sql: string, values?: unknown[]) => { rows: unknown[]; rowCount?: number }) {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [], rowCount: 0 };
    return handler(sql.replace(/\s+/gu, " ").trim(), values);
  });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, query };
}

describe("server-owned onboarding progress", () => {
  it("persists a monotonic step only inside the selected project", async () => {
    const db = database((sql) => {
      if (sql.includes("from user_project_preferences")) return { rows: [membership] };
      if (sql.includes("from onboarding_progress") && sql.includes("for update")) return { rows: [] };
      if (sql.includes("from channels")) return { rows: [{ id: 11 }] };
      if (sql.includes("from content_brief")) return { rows: [{ "?column?": 1 }] };
      if (sql.startsWith("insert into onboarding_progress")) return { rows: [progressRow({ step: 4, version: 1 })] };
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await saveOnboardingProgress({
      userId: 17,
      step: 4,
      channelId: 11,
      pool: db.pool,
    });

    expect(result).toMatchObject({ projectId: 7, step: 4, channelId: 11, version: 1 });
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes("greatest(onboarding_progress.step, excluded.step)"))).toBe(true);
    expect(db.query.mock.calls.some(([, values]) => Array.isArray(values) && values.includes(999))).toBe(false);
  });

  it("marks completion only after the Telegram channel, brief, and first draft all match", async () => {
    const completedAt = "2026-08-01T12:00:00.000Z";
    const db = database((sql) => {
      if (sql.includes("from user_project_preferences")) return { rows: [membership] };
      if (sql.includes("from onboarding_progress") && sql.includes("for update")) return { rows: [progressRow()] };
      if (sql.includes("from channels")) return { rows: [{ id: 11 }] };
      if (sql.includes("from content_brief")) return { rows: [{ "?column?": 1 }] };
      if (sql.includes("from drafts draft")) return { rows: [{ id: 41 }] };
      if (sql.startsWith("update onboarding_progress")) {
        return { rows: [progressRow({ first_draft_id: 41, completed_at: completedAt, version: 5 })] };
      }
      if (sql.startsWith("update users")) return { rows: [{ onboarding_completed_at: completedAt }] };
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await completeOnboarding({
      userId: 17,
      channelId: 11,
      draftId: 41,
      pool: db.pool,
    });

    expect(result).toMatchObject({
      onboardingCompletedAt: completedAt,
      progress: { step: 5, channelId: 11, firstDraftId: 41, completedAt },
    });
    expect(db.query.mock.calls.find(([sql]) => String(sql).includes("from drafts draft"))?.[1])
      .toEqual([41, 7, 11, 17]);
  });

  it("never sets onboarding_completed_at when the first material is absent", async () => {
    const db = database((sql) => {
      if (sql.includes("from user_project_preferences")) return { rows: [membership] };
      if (sql.includes("from onboarding_progress") && sql.includes("for update")) return { rows: [progressRow()] };
      if (sql.includes("from channels")) return { rows: [{ id: 11 }] };
      if (sql.includes("from content_brief")) return { rows: [{ "?column?": 1 }] };
      if (sql.includes("from drafts draft")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });

    await expect(completeOnboarding({
      userId: 17,
      channelId: 11,
      draftId: 41,
      pool: db.pool,
    })).rejects.toEqual(new OnboardingProgressError("material_required"));

    expect(db.query.mock.calls.some(([sql]) => String(sql).includes("update users"))).toBe(false);
    expect(db.query).toHaveBeenCalledWith("rollback");
  });
});
