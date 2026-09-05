import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openOAuthState, sealOAuthState } from "./oauth-state";

const input = { state: "state-proof", verifier: "pkce-verifier", network: "youtube", userId: 7, projectId: 23 };
beforeEach(() => vi.stubEnv("TOKENS_MASTER_KEY", "isolated-oauth-state-key"));
afterEach(() => vi.unstubAllEnvs());
describe("authenticated OAuth project state", () => {
  it("preserves initiating project and rejects user/network changes and expiry", () => {
    const raw = sealOAuthState(input, 1000);
    expect(openOAuthState(raw, 7, "youtube", 1001)).toMatchObject(input);
    expect(openOAuthState(raw, 8, "youtube", 1001)).toBeNull();
    expect(openOAuthState(raw, 7, "instagram", 1001)).toBeNull();
    expect(openOAuthState(raw, 7, "youtube", 601000)).toBeNull();
  });
  it("rejects modified encrypted state and old editable JSON cookies", () => {
    const raw = sealOAuthState(input);
    expect(openOAuthState(raw.slice(0, -1) + (raw.endsWith("0") ? "1" : "0"), 7, "youtube")).toBeNull();
    expect(openOAuthState(JSON.stringify({ ...input, projectId: 41 }), 7, "youtube")).toBeNull();
  });
});
