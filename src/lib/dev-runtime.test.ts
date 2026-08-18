import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const devScript = readFileSync(new URL("../../scripts/dev.mjs", import.meta.url), "utf8");
const devBootstrap = readFileSync(new URL("../../scripts/dev-bootstrap.mjs", import.meta.url), "utf8");
const nextConfig = readFileSync(new URL("../../next.config.ts", import.meta.url), "utf8");
const authScreen = readFileSync(new URL("../components/auth/auth-screen.tsx", import.meta.url), "utf8");

describe("local development runtime", () => {
  it("routes normal dev commands through the web + worker orchestrator", () => {
    expect(packageJson.scripts.dev).toBe("node scripts/dev.mjs");
    expect(packageJson.scripts["dev:web"]).toBe("node scripts/dev.mjs");
    expect(packageJson.scripts["dev:web-only"]).toBe("next dev");
  });

  it("forces the full worker even when the parent environment is restricted", () => {
    expect(devScript).toContain('AURORA_WORKER_MODE: "full"');
    expect(devScript).toContain('--env-file-if-exists=.env.local');
    expect(devScript).not.toContain('["--env-file=.env.local", "worker.mjs"]');
    expect(devScript).toContain('start("worker"');
    expect(devScript).toContain('start("web"');
  });

  it("prepares local services, schema, and migrations before opening the app", () => {
    expect(devScript).toContain("prepareDevelopmentRuntime");
    expect(devBootstrap).toContain('["services", "start", formula]');
    expect(devBootstrap).toContain("bootstrapEmptyLocalDatabase");
    expect(devBootstrap).toContain("await migrate({ env, logger })");
    expect(devBootstrap).toContain("await assertRuntimeSchemaReady({ env })");
  });

  it("allows loopback and local-network dev origins while keeping credentials out of a native GET fallback", () => {
    expect(nextConfig).toContain('new Set(["127.0.0.1", "localhost", ...localNetworkOrigins])');
    expect(nextConfig).toContain("allowedDevOrigins,");
    expect(authScreen).toMatch(/<form[\s\S]*?method="post"[\s\S]*?onSubmit=\{submit\}/);
  });
});
