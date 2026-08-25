import { describe, expect, it } from "vitest";
import { classifyOpportunityFailure, opportunityActionError } from "./opportunities-client-state";

describe("opportunities client state", () => {
  it("keeps domain states separate from transport failures", () => {
    expect(classifyOpportunityFailure(422, "channel_not_found")).toBe("no_channel");
    expect(classifyOpportunityFailure(403, "feature_disabled")).toBe("feature_disabled");
    expect(classifyOpportunityFailure(403, "access_denied")).toBe("access_denied");
    expect(classifyOpportunityFailure(401, "unauthorized")).toBe("session_expired");
    expect(classifyOpportunityFailure(503, "opportunities_unavailable")).toBe("initial_error");
  });

  it("gives stale and missing actions a recoverable message", () => {
    expect(opportunityActionError("opportunity_stale")).toContain("Обновите карту");
    expect(opportunityActionError("opportunity_not_found")).toContain("Обновите карту");
  });
});
