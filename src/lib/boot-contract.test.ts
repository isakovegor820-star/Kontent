import { describe, expect, it, vi } from "vitest";

import { BOOT_CONTRACT_FAILURE_MESSAGE, enforceBootContract } from "./boot-contract";

describe("enforceBootContract", () => {
  it("оставляет процесс живым, когда контракт выполнен", () => {
    const exit = vi.fn();
    const report = vi.fn();

    enforceBootContract(() => {}, { exit, report });

    expect(exit).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it("завершает процесс с кодом 1, когда контракт нарушен", () => {
    // Инвариант инцидента 2026-10-05: раньше провал контракта приводил только к записи
    // в лог, процесс жил и отвечал 500. Теперь провал обязан быть смертью процесса.
    const exit = vi.fn();
    const report = vi.fn();
    const failure = new Error("trusted_proxy_hops_not_configured");

    enforceBootContract(() => {
      throw failure;
    }, { exit, report });

    expect(report).toHaveBeenCalledWith(BOOT_CONTRACT_FAILURE_MESSAGE, failure);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("по умолчанию действительно вызывает process.exit, а не только пишет в лог", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      enforceBootContract(() => {
        throw new Error("trusted_proxy_hops_not_configured");
      });

      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("начинает с проверки контракта, а не после неё", () => {
    const order: string[] = [];

    enforceBootContract(() => order.push("check"), {
      exit: () => order.push("exit"),
      report: () => order.push("report"),
    });
    enforceBootContract(
      () => {
        order.push("check");
        throw new Error("boom");
      },
      { exit: () => order.push("exit"), report: () => order.push("report") },
    );

    expect(order).toEqual(["check", "check", "report", "exit"]);
  });
});
