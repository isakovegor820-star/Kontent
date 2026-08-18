import { describe, expect, it } from "vitest";

import { telegramPollingConflictCooldownMs } from "./telegram-polling-conflict.mjs";

describe("Telegram polling conflict cooldown", () => {
  it("retries a guarded drain promptly without entering a busy loop", () => {
    expect([1, 2, 3, 4, 20].map(telegramPollingConflictCooldownMs)).toEqual([
      1_000,
      2_000,
      5_000,
      10_000,
      10_000,
    ]);
  });
});
