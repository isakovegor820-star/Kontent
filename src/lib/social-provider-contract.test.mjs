import { describe, expect, it } from "vitest";

import { SOCIAL_ADAPTERS } from "./social-providers.mjs";
import { assertFutureProviderAdapter, deliveryUnknown } from "./social-provider-contract.mjs";

describe("future OAuth provider delivery contract", () => {
  it("keeps future and official-access providers fail-closed with reconciliation before retry", () => {
    expect(assertFutureProviderAdapter(SOCIAL_ADAPTERS.youtube)).toBe(true);
    expect(assertFutureProviderAdapter(SOCIAL_ADAPTERS.instagram)).toBe(true);
    expect(SOCIAL_ADAPTERS.youtube.composerSupported).toBe(false);
    expect(SOCIAL_ADAPTERS.instagram.composerSupported).toBe(false);
    expect(assertFutureProviderAdapter(SOCIAL_ADAPTERS.tenchat)).toBe(true);
    expect(SOCIAL_ADAPTERS.tenchat.composerSupported).toBe(false);
  });

  it("never marks an accept-and-drop response retryable", () => {
    expect(deliveryUnknown("provider-operation-1")).toMatchObject({
      outcome: "delivery_unknown",
      deliveryUnknown: true,
      retryable: false,
      providerOperationId: "provider-operation-1",
    });
  });
});
