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

import { enqueueAutopilotPost } from "./autopilot";

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Autopilot queue delivery", () => {
  it("uses the post id as a deterministic BullMQ identity on every replay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T12:00:00.000Z"));
    mocks.add.mockResolvedValue(undefined);

    await enqueueAutopilotPost(501, "2026-08-02T12:05:00.000Z");
    await enqueueAutopilotPost(501, "2026-08-02T12:05:00.000Z");

    expect(mocks.add).toHaveBeenCalledTimes(2);
    expect(mocks.add).toHaveBeenNthCalledWith(1, "publish", { postId: 501, scheduleRevision: 1 }, {
      delay: 300_000,
      jobId: "post-501-r1",
      removeOnComplete: true,
      removeOnFail: false,
    });
    expect(mocks.add.mock.calls[1]).toEqual(mocks.add.mock.calls[0]);
  });
});
