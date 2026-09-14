import { describe, expect, it } from "vitest";

import { resolveProviderLiveWriteBoundary } from "./provider-write-boundary.mjs";

describe("provider live-write boundary", () => {
  it("allows only providers with an implemented live path", () => {
    expect(resolveProviderLiveWriteBoundary("tg")).toMatchObject({ allowed: true, state: "ready" });
    expect(resolveProviderLiveWriteBoundary("vk")).toMatchObject({ allowed: true, state: "ready" });
  });

  it("maps TenChat to a terminal non-retryable result with an export alternative", () => {
    expect(resolveProviderLiveWriteBoundary("tenchat")).toEqual(expect.objectContaining({
      allowed: false,
      terminal: true,
      retryable: false,
      state: "official_access_required",
      error: "official_access_required",
      code: "tenchat_official_access_required",
      exportAvailable: true,
    }));
  });

  it("fails unknown provider input closed", () => {
    expect(resolveProviderLiveWriteBoundary("fake-tenchat")).toMatchObject({
      allowed: false,
      terminal: true,
      error: "provider_operation_unsupported",
      exportAvailable: false,
    });
  });
});
