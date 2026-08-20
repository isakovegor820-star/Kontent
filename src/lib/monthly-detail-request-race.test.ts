import { describe, expect, it } from "vitest";

import { createWorkspaceRequestFence } from "./client-workspace-isolation";
import { isCurrentMonthlyDetailRequest, monthlyDetailRequestIdentity } from "./monthly-detail-request-race";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("monthly campaign detail request race", () => {
  it("keeps campaign B when B resolves before the older campaign A", async () => {
    const fence = createWorkspaceRequestFence();
    let selectedCampaignId = 41;
    let visibleCampaign: string | null = null;
    const a = deferred<string>();
    const b = deferred<string>();

    const load = async (campaignId: number, response: Promise<string>) => {
      const ticket = fence.start(monthlyDetailRequestIdentity(campaignId));
      const detail = await response;
      if (isCurrentMonthlyDetailRequest(fence, ticket, selectedCampaignId)) visibleCampaign = detail;
    };

    const requestA = load(41, a.promise);
    selectedCampaignId = 42;
    const requestB = load(42, b.promise);
    b.resolve("campaign-b");
    await requestB;
    a.resolve("campaign-a");
    await requestA;

    expect(visibleCampaign).toBe("campaign-b");
  });
});
