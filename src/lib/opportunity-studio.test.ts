import { describe, expect, it } from "vitest";

import {
  opportunityStudioHref,
  studioGrowthMoveGenerationIdentity,
} from "./opportunity-studio";

describe("opportunity Studio handoff", () => {
  it("builds an id-only Studio URL for the exact opportunity and channel", () => {
    expect(opportunityStudioHref({ growthMoveId: 17, opportunityId: 29, channelId: 4 }))
      .toBe("/app/studio?growthMove=17&opportunity=29&channel=4&intent=create");
  });

  it("uses stable generation keys across safe retries", () => {
    expect(studioGrowthMoveGenerationIdentity(17)).toEqual({
      requestKey: "studio_growth_move_17",
      resultClientKey: "draft_result_studio_growth_move_17",
    });
    expect(studioGrowthMoveGenerationIdentity(17))
      .toEqual(studioGrowthMoveGenerationIdentity(17));
  });

  it("rejects unsafe identifiers", () => {
    expect(() => opportunityStudioHref({ growthMoveId: 0, opportunityId: 2, channelId: 3 }))
      .toThrow(RangeError);
    expect(() => studioGrowthMoveGenerationIdentity(Number.NaN)).toThrow(RangeError);
  });
});
