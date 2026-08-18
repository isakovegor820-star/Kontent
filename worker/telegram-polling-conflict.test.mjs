import { describe, expect, it } from "vitest";

import { telegramPollingConflictCooldownMs } from "./telegram-polling-conflict.mjs";

describe("Telegram polling conflict cooldown", () => {
  it("backs off repeated conflicts and caps the cooldown", () => {
    expect([1, 2, 3, 4, 20].map(telegramPollingConflictCooldownMs)).toEqual([
      60_000,
      120_000,
      300_000,
      600_000,
      600_000,
    ]);
  });
});
