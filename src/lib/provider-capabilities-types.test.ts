import { describe, expect, it } from "vitest";

import {
  type ProviderCapability,
  type ProviderOperationReadiness,
  getProviderCapability,
  providerCapabilityCatalog,
  resolveProviderOperation,
} from "./provider-capabilities.mjs";

describe("provider capability TypeScript consumer contract", () => {
  it("exposes the same serializable registry to Next.js and worker ESM consumers", () => {
    const nextCatalog: readonly ProviderCapability[] = providerCapabilityCatalog();
    const workerCatalog = JSON.parse(JSON.stringify(providerCapabilityCatalog())) as ProviderCapability[];

    expect(workerCatalog).toEqual(nextCatalog);
    expect(getProviderCapability("tg")?.limits.textChars).toBe(4096);
  });

  it("keeps typed readiness unavailable until the server proves credentials and permissions", () => {
    const readiness: ProviderOperationReadiness = resolveProviderOperation("vk", "livePublish");
    expect(readiness.available).toBe(false);
    expect(readiness.state).toBe("credential_unknown");
  });
});
