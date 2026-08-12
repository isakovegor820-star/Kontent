import { describe, expect, it, vi } from "vitest";

import {
  AutopilotProjectScopeError,
  requireAutopilotPlanJobScope,
} from "./autopilot-project-scope.mjs";

describe("Autopilot worker project scope", () => {
  it("requires the project captured in the queue payload", async () => {
    const query = vi.fn();
    await expect(requireAutopilotPlanJobScope({ query }, {
      planId: 44,
      userId: 3,
      channelId: 7,
    })).rejects.toMatchObject({
      name: "AutopilotProjectScopeError",
      code: "bad_project_id",
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("accepts project A only when plan, channel, settings, brief and member share A", async () => {
    const query = vi.fn(async (_sql, params) => ({
      rows: params[1] === 11 ? [{ id: 44 }] : [],
      rowCount: params[1] === 11 ? 1 : 0,
    }));
    const db = { query };

    await expect(requireAutopilotPlanJobScope(db, {
      planId: 44,
      projectId: 11,
      userId: 3,
      channelId: 7,
    })).resolves.toEqual({ planId: 44, projectId: 11, userId: 3, channelId: 7 });

    await expect(requireAutopilotPlanJobScope(db, {
      planId: 44,
      projectId: 12,
      userId: 3,
      channelId: 7,
    })).rejects.toBeInstanceOf(AutopilotProjectScopeError);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("settings.project_id = plan.project_id");
    expect(sql).toContain("brief.project_id = plan.project_id");
    expect(sql).toContain("member.project_id = plan.project_id");
    expect(sql).toContain("member.role in ('owner','author','approver')");
    expect(params).toEqual([44, 11, 3, 7]);
  });
});
