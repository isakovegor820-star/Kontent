import { describe, expect, it } from "vitest";

import { createWorkspaceRequestFence } from "./client-workspace-isolation";
import { growthRequestIdentity, isCurrentGrowthRequest } from "./growth-request-race";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Growth channel request race", () => {
  it("keeps board B when B resolves before the older board A", async () => {
    const fence = createWorkspaceRequestFence();
    let selectedChannel = 11;
    let visibleBoard: string | null = null;
    const a = deferred<string>();
    const b = deferred<string>();

    const load = async (channelId: number, response: Promise<string>) => {
      const ticket = fence.start(growthRequestIdentity(channelId));
      const board = await response;
      if (isCurrentGrowthRequest(fence, ticket, selectedChannel)) visibleBoard = board;
    };

    const requestA = load(11, a.promise);
    selectedChannel = 22;
    const requestB = load(22, b.promise);
    b.resolve("board-b");
    await requestB;
    a.resolve("board-a");
    await requestA;

    expect(visibleBoard).toBe("board-b");
  });
});
