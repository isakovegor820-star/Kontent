import { describe, expect, it, vi } from "vitest";

import {
  ADMIN_QUEUE_NAMES,
  loadAdminSystemDiagnostics,
  measureEventLoopLag,
  runDiagnosticDefinitions,
  type DiagnosticDefinition,
} from "./admin-system-diagnostics";

describe("admin system diagnostics", () => {
  it("settles checks independently and never serializes a rejected error", async () => {
    const healthy = vi.fn(async () => ({
      state: "healthy" as const,
      evidence: [{ label: "PING", value: "4 мс" }],
    }));
    const failed = vi.fn(async () => {
      throw new Error("postgresql://private:secret@host/database");
    });
    const definitions: DiagnosticDefinition[] = [
      { id: "one", group: "core", label: "One", description: "One", run: healthy },
      { id: "two", group: "integrations", label: "Two", description: "Two", run: failed },
    ];

    const components = await runDiagnosticDefinitions(definitions);
    expect(healthy).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledOnce();
    expect(components).toMatchObject([
      { id: "one", state: "healthy", safeErrorCode: null, lastSuccessAt: expect.any(String) },
      { id: "two", state: "down", safeErrorCode: "two_check_failed", lastSuccessAt: null },
    ]);
    expect(JSON.stringify(components)).not.toContain("postgresql://");
    expect(JSON.stringify(components)).not.toContain("private");
  });

  it("counts unobserved/not-configured as warnings and core down as platform down", async () => {
    const definitions: DiagnosticDefinition[] = [
      {
        id: "web_api", group: "core", label: "Web", description: "Web",
        run: async () => ({ state: "healthy", evidence: [] }),
      },
      {
        id: "redis", group: "core", label: "Redis", description: "Redis",
        run: async () => ({ state: "down", evidence: [], safeErrorCode: "redis_unavailable" }),
      },
      {
        id: "ai", group: "integrations", label: "AI", description: "AI",
        run: async () => ({ state: "unobserved", evidence: [] }),
      },
    ];
    const report = await loadAdminSystemDiagnostics({ definitions });
    expect(report.state).toBe("down");
    expect(report.summary).toEqual({ total: 3, healthy: 1, configured: 0, warnings: 1, critical: 1 });
  });

  it("keeps configuration-only checks out of both healthy and warning totals", async () => {
    const definitions: DiagnosticDefinition[] = [
      {
        id: "postgresql", group: "core", label: "PostgreSQL", description: "DB",
        run: async () => ({ state: "healthy", evidence: [] }),
      },
      {
        id: "https_origin", group: "security", label: "HTTPS", description: "Origin",
        run: async () => ({ state: "configured", evidence: [{ label: "Протокол", value: "https" }] }),
      },
    ];
    const report = await loadAdminSystemDiagnostics({ definitions });
    expect(report.state).toBe("healthy");
    expect(report.summary).toEqual({ total: 2, healthy: 1, configured: 1, warnings: 0, critical: 0 });
    // A configured-only component never earns a "last success" timestamp: nothing was observed.
    expect(report.components[1]).toMatchObject({ state: "configured", lastSuccessAt: null });
  });

  it("measures event loop lag as a non-negative integer", async () => {
    const lag = await measureEventLoopLag();
    expect(Number.isInteger(lag)).toBe(true);
    expect(lag).toBeGreaterThanOrEqual(0);
  });

  it("includes every queue that is actually declared by Aurora runtimes", () => {
    expect(ADMIN_QUEUE_NAMES).toEqual([
      "publish",
      "stats",
      "media-generation",
      "autopilot-plans",
      "site-analysis",
      "project-export",
      "publication-extra",
      "monthly-campaign-regeneration",
      "legal-visual-render",
      "publication-review-reminder",
      "cron",
    ]);
  });
});
