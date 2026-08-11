import { describe, expect, it } from "vitest";

import {
  PROVIDER_CAPABILITY_REGISTRY,
  PROVIDER_CREDENTIAL_STATES,
  PROVIDER_IDS,
  PROVIDER_OPERATIONS,
  PROVIDER_PERMISSION_STATES,
  ProviderCapabilityError,
  assertProviderOperationAvailable,
  getProviderCapability,
  normalizeProviderId,
  providerCapabilityCatalog,
  providerSupportsMediaType,
  providerSupportsOperation,
  resolveProviderOperation,
} from "./provider-capabilities.mjs";

describe("shared provider capability registry", () => {
  it("contains every supported product provider and complete operation records", () => {
    expect(PROVIDER_IDS).toEqual(["tg", "vk", "rss", "youtube", "instagram", "tenchat"]);
    expect(providerCapabilityCatalog().map((provider) => provider.id)).toEqual(PROVIDER_IDS);
    for (const provider of providerCapabilityCatalog()) {
      expect(Object.keys(provider.capabilities)).toEqual(PROVIDER_OPERATIONS);
      expect(Object.isFrozen(provider)).toBe(true);
      expect(Object.isFrozen(provider.capabilities)).toBe(true);
      expect(Object.isFrozen(provider.mediaTypes)).toBe(true);
      expect(provider).not.toHaveProperty("token");
      expect(provider).not.toHaveProperty("secret");
    }
  });

  it("uses canonical aliases without inventing unknown providers", () => {
    expect(normalizeProviderId(" Telegram ")).toBe("tg");
    expect(getProviderCapability("telegram")).toBe(PROVIDER_CAPABILITY_REGISTRY.tg);
    expect(normalizeProviderId("future-network")).toBeNull();
    expect(getProviderCapability("future-network")).toBeNull();
  });

  it("keeps current live publishing fail-closed", () => {
    expect(providerSupportsOperation("tg", "livePublish")).toBe(true);
    expect(providerSupportsOperation("vk", "livePublish")).toBe(true);
    expect(providerSupportsOperation("rss", "livePublish")).toBe(false);
    expect(providerSupportsOperation("youtube", "livePublish")).toBe(false);
    expect(providerSupportsOperation("instagram", "livePublish")).toBe(false);
    expect(providerSupportsOperation("tenchat", "livePublish")).toBe(false);
    expect(providerSupportsOperation("future-network", "livePublish")).toBe(false);
    expect(providerSupportsOperation("tg", "future-operation")).toBe(false);
  });

  it("requires proven credentials and permissions for a supported write", () => {
    expect(resolveProviderOperation("tg", "livePublish")).toMatchObject({
      available: false,
      state: "credential_unknown",
    });
    expect(resolveProviderOperation("tg", "livePublish", {
      credentialState: PROVIDER_CREDENTIAL_STATES.READY,
    })).toMatchObject({
      available: false,
      state: "permission_unknown",
    });
    expect(resolveProviderOperation("tg", "livePublish", {
      credentialState: PROVIDER_CREDENTIAL_STATES.READY,
      permissionState: PROVIDER_PERMISSION_STATES.MISSING,
    })).toMatchObject({
      available: false,
      state: "permission_missing",
    });
    expect(resolveProviderOperation("tg", "livePublish", {
      credentialState: PROVIDER_CREDENTIAL_STATES.READY,
      permissionState: PROVIDER_PERMISSION_STATES.READY,
    })).toEqual({
      available: true,
      providerId: "tg",
      operation: "livePublish",
      state: "ready",
      reason: null,
      message: null,
    });
  });

  it("allows only an export package for TenChat without claiming an API", () => {
    expect(resolveProviderOperation("tenchat", "exportPackage")).toMatchObject({
      available: true,
      state: "ready",
    });
    expect(resolveProviderOperation("tenchat", "livePublish", {
      credentialState: PROVIDER_CREDENTIAL_STATES.READY,
      permissionState: PROVIDER_PERMISSION_STATES.READY,
    })).toMatchObject({
      available: false,
      state: "official_access_required",
      reason: "official_access_required",
    });
    expect(PROVIDER_CAPABILITY_REGISTRY.tenchat.capabilities.livePublish.message)
      .toContain("подтверждённый официальный доступ");
    expect(PROVIDER_CAPABILITY_REGISTRY.tenchat.officialAccess).toMatchObject({
      verified: false,
      contactUrl: "https://tenchat.ru/contacts",
    });
  });

  it("publishes only media types implemented by the current product path", () => {
    expect(providerSupportsMediaType("tg", "image")).toBe(true);
    expect(providerSupportsMediaType("tg", "video")).toBe(true);
    expect(providerSupportsMediaType("vk", "image")).toBe(false);
    expect(providerSupportsMediaType("rss", "text")).toBe(false);
    expect(providerSupportsMediaType("future-network", "text")).toBe(false);
  });

  it("throws a typed fail-closed error for unavailable operations", () => {
    expect(() => assertProviderOperationAvailable("youtube", "livePublish", {
      credentialState: PROVIDER_CREDENTIAL_STATES.READY,
      permissionState: PROVIDER_PERMISSION_STATES.READY,
    })).toThrow(ProviderCapabilityError);
    expect(() => assertProviderOperationAvailable("future-network", "livePublish"))
      .toThrow("Провайдер не поддерживается");
  });
});
