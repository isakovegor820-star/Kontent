import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { installCrashGuards } from "./crash-guards.mjs";

const installed = [];

afterEach(() => {
  while (installed.length > 0) installed.pop()?.dispose();
  vi.useRealTimers();
});

function install(options) {
  const handleFatal = installCrashGuards(options);
  installed.push(handleFatal);
  return handleFatal;
}

function fakeLogger() {
  return { error: vi.fn(), warn: vi.fn(), log: vi.fn() };
}

describe("worker crash guards", () => {
  it("reports, drains and exits with code 1 on a fatal unhandled rejection", async () => {
    const logger = fakeLogger();
    const captureException = vi.fn();
    const onFatal = vi.fn(async () => {});
    const exit = vi.fn();
    const handleFatal = install({ logger, captureException, onFatal, exit });

    await handleFatal("unhandledRejection", new Error("boom"));

    expect(logger.error).toHaveBeenCalledWith(
      "[worker] фатальная ошибка процесса",
      expect.objectContaining({ kind: "unhandledRejection", message: "boom" }),
    );
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      { captureContext: { tags: { crash_kind: "unhandledRejection" } } },
    );
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("normalizes non-Error rejection reasons", async () => {
    const logger = fakeLogger();
    const exit = vi.fn();
    const handleFatal = install({ logger, exit });

    await handleFatal("unhandledRejection", "string failure");

    expect(logger.error).toHaveBeenCalledWith(
      "[worker] фатальная ошибка процесса",
      expect.objectContaining({ message: "string failure" }),
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("only the first fatal gets a drain; a second one exits immediately", async () => {
    const logger = fakeLogger();
    const exit = vi.fn();
    let releaseDrain;
    const drainGate = new Promise((resolve) => { releaseDrain = resolve; });
    const onFatal = vi.fn(() => drainGate);
    const handleFatal = install({ logger, onFatal, exit, drainTimeoutMs: 10 });

    const first = handleFatal("uncaughtException", new Error("first"));
    const second = handleFatal("uncaughtException", new Error("second"));
    await second;
    releaseDrain();
    await first;

    // Первая фатальная дождётся дренажа (с таймаутом), вторая — мгновенный exit(1).
    expect(exit).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenNthCalledWith(1, 1);
    expect(exit).toHaveBeenNthCalledWith(2, 1);
    expect(logger.error).toHaveBeenCalledWith(
      "[worker] повторная фатальная ошибка во время завершения — мгновенный выход",
      { kind: "uncaughtException" },
    );
  });

  it("hard-caps a hanging drain with the timeout and still exits", async () => {
    vi.useFakeTimers();
    const logger = fakeLogger();
    const exit = vi.fn();
    const handleFatal = install({
      logger,
      onFatal: () => new Promise(() => {}), // никогда не завершится
      exit,
      drainTimeoutMs: 1_000,
    });

    const pending = handleFatal("uncaughtException", new Error("hang"));
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;

    expect(exit).toHaveBeenCalledWith(1);
  });

  it("survives a throwing captureException and a throwing drain", async () => {
    const logger = fakeLogger();
    const exit = vi.fn();
    const handleFatal = install({
      logger,
      captureException: () => { throw new Error("sentry down"); },
      onFatal: async () => { throw new Error("drain failed"); },
      exit,
    });

    await expect(handleFatal("unhandledRejection", new Error("boom"))).resolves.toBeUndefined();

    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      "[worker] дренаж после фатальной ошибки не завершился — выходим",
      { message: "drain failed" },
    );
  });

  it("worker.mjs installs the guards and keeps Sentry from owning the exit", () => {
    const source = readFileSync(new URL("../worker.mjs", import.meta.url), "utf8");
    expect(source).toContain('installCrashGuards');
    expect(source).toContain('from "./worker/crash-guards.mjs"');

    const sentryConfig = readFileSync(new URL("../sentry.worker.config.mjs", import.meta.url), "utf8");
    // Выход процесса принадлежит crash-guards; Sentry только репортит.
    expect(sentryConfig).toContain("onUncaughtExceptionIntegration");
    expect(sentryConfig).toContain("exitOnUncaught: false");
  });
});
