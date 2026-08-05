import { describe, expect, it } from "vitest";

import { passwordResetRequestOutcome } from "./password-reset-client";

describe("password reset request UI outcome", () => {
  it("shows the generic accepted state only after the server accepted the request", () => {
    expect(passwordResetRequestOutcome(202, true)).toBe("accepted");
    expect(passwordResetRequestOutcome(500, false, "server")).toBe("failed");
  });

  it("does not turn a fail-closed rate limiter outage into a success message", () => {
    expect(passwordResetRequestOutcome(503, false, "rate_limit_unavailable"))
      .toBe("temporarily_unavailable");
    expect(passwordResetRequestOutcome(429, false, "rate_limited")).toBe("rate_limited");
  });
});
