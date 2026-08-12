import { describe, expect, it } from "vitest";
import { probeMailDeliveryConfiguration, probeTrackingSecretsConfiguration } from "./readiness-probes";

describe("password recovery readiness configuration", () => {
  const configured = {
    NODE_ENV: "production",
    APP_URL: "https://aurora.example",
    RESEND_API_KEY: "provider-key",
    PASSWORD_RESET_FROM: "security@example.test",
    TOKENS_MASTER_KEY: "envelope-key",
  } as NodeJS.ProcessEnv;

  it("requires public URL, provider, sender and durable token-envelope key", () => {
    expect(probeMailDeliveryConfiguration(configured)).toBe("up");
    expect(probeMailDeliveryConfiguration({ ...configured, APP_URL: "" })).toBe("not_configured");
    expect(probeMailDeliveryConfiguration({ ...configured, RESEND_API_KEY: "" })).toBe("not_configured");
    expect(probeMailDeliveryConfiguration({ ...configured, PASSWORD_RESET_FROM: "" })).toBe("not_configured");
    expect(probeMailDeliveryConfiguration({ ...configured, TOKENS_MASTER_KEY: "" })).toBe("not_configured");
    expect(probeMailDeliveryConfiguration({ ...configured, APP_URL: "http://aurora.example" })).toBe("not_configured");
  });
});

describe("tracking secrets readiness configuration", () => {
  it("requires two different secrets with at least 32 characters", () => {
    const configured = {
      NODE_ENV: "test",
      TRACKING_ATTRIBUTION_SECRET: "a".repeat(48),
      TRACKING_FINGERPRINT_SECRET: "b".repeat(48),
    } as NodeJS.ProcessEnv;
    expect(probeTrackingSecretsConfiguration(configured)).toBe("up");
    expect(probeTrackingSecretsConfiguration({ NODE_ENV: "test" })).toBe("not_configured");
    expect(probeTrackingSecretsConfiguration({
      ...configured,
      TRACKING_FINGERPRINT_SECRET: "short",
    })).toBe("down");
    expect(probeTrackingSecretsConfiguration({
      ...configured,
      TRACKING_FINGERPRINT_SECRET: configured.TRACKING_ATTRIBUTION_SECRET,
    })).toBe("down");
  });
});
