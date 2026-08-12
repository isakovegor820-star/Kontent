import { describe, expect, it } from "vitest";

import {
  readTenChatServerConfig,
  TenChatConfigurationError,
  tenChatIntegrationReadiness,
} from "./tenchat-integration.mjs";

const validEnv = {
  TENCHAT_OFFICIAL_ACCESS_MODE: "written_partner_agreement",
  TENCHAT_OFFICIAL_ACCESS_GRANT_ID: "partner-contract-2026-42",
  TENCHAT_OFFICIAL_API_BASE_URL: "https://partner-api.tenchat.ru/v1/",
  TENCHAT_OFFICIAL_API_TOKEN: "T".repeat(48),
};

describe("TenChat official integration boundary", () => {
  it("keeps live publishing terminal when no written access is supplied", () => {
    expect(readTenChatServerConfig({})).toBeNull();
    expect(tenChatIntegrationReadiness({})).toMatchObject({
      mode: "export_only",
      livePublish: {
        available: false,
        state: "official_access_required",
        terminal: true,
        retryable: false,
      },
      exportPackage: { available: true, manualPublishRequired: true },
      configuration: { state: "not_supplied", secretsExposed: false },
    });
  });

  it("rejects fake, non-TenChat and non-HTTPS provider boundaries", () => {
    expect(() => readTenChatServerConfig({
      ...validEnv,
      TENCHAT_OFFICIAL_API_BASE_URL: "https://tenchat.example/api",
    })).toThrowError(TenChatConfigurationError);
    expect(() => readTenChatServerConfig({
      ...validEnv,
      TENCHAT_OFFICIAL_API_BASE_URL: "http://api.tenchat.ru/v1",
    })).toThrow("tenchat_api_base_url_invalid");
  });

  it("reports incomplete configuration without exposing supplied secret values", () => {
    const readiness = tenChatIntegrationReadiness({
      TENCHAT_OFFICIAL_API_TOKEN: "do-not-expose-".repeat(4),
    });
    expect(readiness.configuration).toMatchObject({
      state: "invalid",
      error: "tenchat_config_incomplete",
      configuredForImplementation: false,
    });
    expect(JSON.stringify(readiness)).not.toContain("do-not-expose");
  });

  it("treats a complete server config only as adapter implementation readiness", () => {
    const serverConfig = readTenChatServerConfig(validEnv);
    expect(serverConfig).toMatchObject({
      apiBaseUrl: "https://partner-api.tenchat.ru/v1",
      grantId: "partner-contract-2026-42",
    });
    const readiness = tenChatIntegrationReadiness(validEnv);
    expect(readiness.configuration).toMatchObject({
      state: "adapter_implementation_required",
      configuredForImplementation: true,
      secretsExposed: false,
    });
    expect(readiness.livePublish.available).toBe(false);
    expect(JSON.stringify(readiness)).not.toContain(validEnv.TENCHAT_OFFICIAL_API_TOKEN);
    expect(JSON.stringify(readiness)).not.toContain(validEnv.TENCHAT_OFFICIAL_ACCESS_GRANT_ID);
  });
});
