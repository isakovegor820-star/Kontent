import { describe, expect, it } from "vitest";
import {
  DevelopmentDependencyError,
  isLoopbackConnection,
  pickPostgresFormula,
  waitForDependency,
} from "./dev-bootstrap.mjs";

describe("development bootstrap", () => {
  it("only treats loopback dependencies as locally managed", () => {
    expect(isLoopbackConnection("postgresql://localhost:5432/aurora")).toBe(true);
    expect(isLoopbackConnection("redis://127.0.0.1:6379")).toBe(true);
    expect(isLoopbackConnection("postgresql://db.example.com/aurora")).toBe(false);
  });

  it("selects the newest installed versioned PostgreSQL formula", () => {
    expect(pickPostgresFormula(["redis", "postgresql@16", "postgresql@17"])).toBe(
      "postgresql@17",
    );
  });

  it("waits through a short startup delay", async () => {
    let attempts = 0;
    let clock = 0;
    await waitForDependency(
      "test",
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("not ready");
      },
      {
        timeoutMs: 1_000,
        intervalMs: 100,
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
      },
    );
    expect(attempts).toBe(3);
  });

  it("fails with a safe dependency error after the timeout", async () => {
    let clock = 0;
    const failure = waitForDependency("Redis", async () => {
      throw new Error("connection details that must stay hidden");
    }, {
      timeoutMs: 1_000,
      intervalMs: 500,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    });

    await expect(failure).rejects.toBeInstanceOf(DevelopmentDependencyError);
    await expect(
      waitForDependency("Redis", async () => {
        throw new Error("connection details that must stay hidden");
      }, {
        timeoutMs: 1_000,
        intervalMs: 500,
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
      }),
    ).rejects.toEqual(expect.objectContaining({
      name: "DevelopmentDependencyError",
      code: "development_dependency_unavailable",
    }));
  });
});
