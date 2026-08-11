import { describe, expect, it } from "vitest";

import {
  PROVIDER_CREDENTIAL_STATES,
  PROVIDER_PERMISSION_STATES,
  getProviderCapability,
  providerCapabilityCatalog,
  resolveProviderOperation,
} from "../src/lib/provider-capabilities.mjs";

describe("worker provider capability contract", () => {
  it("reads the exact immutable catalog used by the Next.js process", () => {
    const catalog = providerCapabilityCatalog();

    expect(Object.isFrozen(catalog)).toBe(true);
    expect(catalog.find((provider) => provider.id === "tg")).toBe(getProviderCapability("tg"));
    expect(catalog.map((provider) => provider.id)).toEqual([
      "tg",
      "vk",
      "rss",
      "youtube",
      "instagram",
      "tenchat",
    ]);
  });

  it("permits a worker write only after credentials and permissions are proven", () => {
    expect(resolveProviderOperation("vk", "livePublish", {
      credentialState: PROVIDER_CREDENTIAL_STATES.READY,
      permissionState: PROVIDER_PERMISSION_STATES.READY,
    })).toMatchObject({ available: true, state: "ready" });

    expect(resolveProviderOperation("youtube", "livePublish", {
      credentialState: PROVIDER_CREDENTIAL_STATES.READY,
      permissionState: PROVIDER_PERMISSION_STATES.READY,
    })).toMatchObject({ available: false, state: "unsupported" });
  });
});
