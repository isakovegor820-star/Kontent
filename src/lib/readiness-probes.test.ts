import { describe, expect, it } from "vitest";
import { probeMailDeliveryConfiguration } from "./readiness-probes";

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
