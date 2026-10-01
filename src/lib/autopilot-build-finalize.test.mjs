import { describe, expect, it, vi } from "vitest";
import {
  AUTOPILOT_COMMITTED_RESULT_STATUSES,
  committedAutopilotResultExistsSql,
  finalizeAutopilotBuildPlaceholder,
  supersedeAutopilotAttempts,
} from "./autopilot-build-finalize.mjs";

function client(rowCount = 1) {
  return { query: vi.fn(async () => ({ rows: rowCount ? [{ id: "701" }] : [], rowCount })) };
}

describe("finalizeAutopilotBuildPlaceholder", () => {
  // Оставленный `building`-плейсхолдер — это и бесконечный спиннер на странице, и вечный
  // повтор сборки: reconciler каждые 30 секунд видит незавершённую работу и заказывает
  // ещё один полный прогон модели.
  it("closes only the exact building row and records the committed result", async () => {
    const tx = client(1);

    await expect(finalizeAutopilotBuildPlaceholder(tx, {
      projectId: 4,
      channelId: 12,
      planId: 701,
      resultPlanId: 702,
    })).resolves.toEqual({ finalized: true });

    const [sql, params] = tx.query.mock.calls[0];
    expect(sql).toContain("set status = 'done', terminal_outcome = 'complete'");
    expect(sql).toContain("and status = 'building'");
    expect(sql).toContain("coalesce(build_report, '{}'::jsonb) || $4::jsonb");
    expect(params).toEqual([701, 4, 12, JSON.stringify({ resultPlanId: 702 })]);
  });

  it("reports a lost race instead of touching somebody else's row", async () => {
    const tx = client(0);

    await expect(finalizeAutopilotBuildPlaceholder(tx, {
      projectId: 4,
      channelId: 12,
      planId: 701,
    })).resolves.toEqual({ finalized: false });

    const [sql, params] = tx.query.mock.calls[0];
    expect(sql).toContain("and status = 'building'");
    expect(params).toEqual([701, 4, 12, "{}"]);
  });

  it("refuses an invalid scope before writing", async () => {
    const tx = client(1);

    await expect(finalizeAutopilotBuildPlaceholder(tx, {
      projectId: 0,
      channelId: 12,
      planId: 701,
    })).rejects.toThrow("autopilot_finalize_invalid_project_id");
    expect(tx.query).not.toHaveBeenCalled();
  });
});

describe("supersedeAutopilotAttempts", () => {
  it("archives earlier failed and partial attempts of the channel", async () => {
    const tx = client(2);

    await expect(supersedeAutopilotAttempts(tx, {
      projectId: 4,
      channelId: 12,
      keepPlanId: 702,
    })).resolves.toEqual({ superseded: 2 });

    const [sql, params] = tx.query.mock.calls[0];
    expect(sql).toContain("set status = 'done'");
    expect(sql).toContain("and status in ('error', 'partial')");
    expect(sql).toContain("weekly_autopilot_plan_id = autopilot_plan.id");
    expect(params).toEqual([4, 12, 702]);
  });

  it("keeps the freshly committed plan out of the archive sweep", async () => {
    const tx = client(0);

    await supersedeAutopilotAttempts(tx, { projectId: 4, channelId: 12 });

    expect(tx.query.mock.calls[0][0]).toContain("($3::bigint is null or id <> $3::bigint)");
    expect(tx.query.mock.calls[0][1]).toEqual([4, 12, null]);
  });
});

describe("committedAutopilotResultExistsSql", () => {
  // Единственный признак «сборка уже записала результат»: строка плана, созданная после
  // плейсхолдера. Во время настоящей сборки такой строки не существует.
  it("looks for a newer committed plan row of the same channel", () => {
    const sql = committedAutopilotResultExistsSql("plan");

    expect(AUTOPILOT_COMMITTED_RESULT_STATUSES).toEqual(["pending", "approved", "approving"]);
    expect(sql).toContain("from autopilot_plan committed");
    expect(sql).toContain("committed.project_id = plan.project_id");
    expect(sql).toContain("committed.channel_id = plan.channel_id");
    expect(sql).toContain("committed.status in ('pending', 'approved', 'approving')");
    expect(sql).toContain("(committed.created_at, committed.id) > (plan.created_at, plan.id)");
  });
});
