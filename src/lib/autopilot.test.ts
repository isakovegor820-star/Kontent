import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  query: vi.fn(),
}));

vi.mock("./db", () => ({
  getPool: () => ({ query: mocks.query }),
}));
vi.mock("./queue", () => ({
  getPublishQueue: () => ({ add: mocks.add }),
  jobIdForPostRevision: (postId: number | string, revision: number | string) =>
    `post-${postId}-r${revision}`,
}));

import { enqueueAutopilotPost, ensureSettings, resolveChannel } from "./autopilot";

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Autopilot queue delivery", () => {
  it("uses the post id as a deterministic BullMQ identity on every replay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T12:00:00.000Z"));
    mocks.add.mockResolvedValue(undefined);

    await enqueueAutopilotPost(77, 501, "2026-08-02T12:05:00.000Z");
    await enqueueAutopilotPost(77, 501, "2026-08-02T12:05:00.000Z");

    expect(mocks.add).toHaveBeenCalledTimes(2);
    expect(mocks.add).toHaveBeenNthCalledWith(1, "publish", {
      projectId: 77,
      postId: 501,
      scheduleRevision: 1,
    }, {
      delay: 300_000,
      jobId: "post-501-r1",
      removeOnComplete: true,
      removeOnFail: false,
    });
    expect(mocks.add.mock.calls[1]).toEqual(mocks.add.mock.calls[0]);
  });
});

describe("Autopilot project channel boundary", () => {
  it("initializes settings only through the project/channel conflict key", async () => {
    const settings = {
      enabled: false,
      mode: "confirm",
      post_frequency: 5,
      approvals_streak: 0,
      generation_engine: "navy-deepseek-flash",
      planning_months: 1,
      planning_weeks: 4,
      news_sources: [],
      quick_settings: {},
    };
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [settings], rowCount: 1 });

    await expect(ensureSettings({ actorUserId: 4, projectId: 88 }, 99)).resolves.toEqual(settings);

    const insert = String(mocks.query.mock.calls[1][0]);
    expect(insert).toContain("on conflict do nothing");
    expect(insert).not.toMatch(/on conflict \([^)]*\)/u);
    expect(mocks.query.mock.calls[1][1]?.slice(0, 3)).toEqual([88, 4, 99]);
    expect(mocks.query.mock.calls[2][1]).toEqual([88, 99]);
  });

  it("resolves compatibility callers through the server-selected project", async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ project_id: "88", user_id: "4", role: "author", version: "1" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(resolveChannel(4, 99)).resolves.toBeNull();

    expect(mocks.query.mock.calls[0][0]).toContain("from user_project_preferences");
    expect(mocks.query.mock.calls[0][1]).toEqual([4]);
    expect(mocks.query.mock.calls[1][0]).toContain("id = $1 and project_id = $2");
    expect(mocks.query.mock.calls[1][1]).toEqual([99, 88]);
  });

  it("does not resolve a project A channel while project B is selected", async () => {
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await expect(resolveChannel({ actorUserId: 4, projectId: 88 }, 99)).resolves.toBeNull();

    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("id = $1 and project_id = $2"),
      [99, 88],
    );
    expect(mocks.query.mock.calls[0][0]).not.toContain("user_id");
  });

  it("lets a shared project member resolve a channel created by another actor", async () => {
    mocks.query.mockResolvedValue({ rows: [{ id: "99" }], rowCount: 1 });

    await expect(resolveChannel({ actorUserId: 4, projectId: 88 }, 99)).resolves.toBe(99);

    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("project_id = $2"),
      [99, 88],
    );
  });
});
