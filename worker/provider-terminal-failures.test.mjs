import { describe, expect, it } from "vitest";

import { providerTerminalFailure } from "./provider-terminal-failures.mjs";

describe("worker terminal provider failure", () => {
  it("ends TenChat live work without a retry or a success claim", () => {
    expect(providerTerminalFailure("tenchat")).toEqual(expect.objectContaining({
      status: "failed",
      terminal: true,
      retryable: false,
      error: "official_access_required",
      errorCode: "tenchat_official_access_required",
      livePublished: false,
      exportAvailable: true,
    }));
  });

  it("does not intercept supported live providers", () => {
    expect(providerTerminalFailure("tg")).toBeNull();
    expect(providerTerminalFailure("vk")).toBeNull();
  });
});
