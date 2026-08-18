import { describe, expect, it, vi } from "vitest";

import {
  TELEGRAM_POLLING_LEASE_KEY,
  TELEGRAM_POLLING_LEASE_TTL_SECONDS,
  acquireTelegramPollingLease,
  releaseTelegramPollingLease,
  renewTelegramPollingLease,
} from "./telegram-polling-lease.mjs";

describe("Telegram polling distributed lease", () => {
  it("lets only an NX winner start polling", async () => {
    const redis = { set: vi.fn().mockResolvedValue("OK"), eval: vi.fn() };
    await expect(acquireTelegramPollingLease(redis, "worker-a")).resolves.toBe(true);
    expect(redis.set).toHaveBeenCalledWith(
      TELEGRAM_POLLING_LEASE_KEY,
      "worker-a",
      "EX",
      TELEGRAM_POLLING_LEASE_TTL_SECONDS,
      "NX",
    );
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it("renews and releases only when the stored owner still matches", async () => {
    const redis = { eval: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0) };
    await expect(renewTelegramPollingLease(redis, "worker-a")).resolves.toBe(true);
    await expect(releaseTelegramPollingLease(redis, "worker-a")).resolves.toBe(false);
    expect(redis.eval).toHaveBeenCalledTimes(2);
  });

  it("keeps a second process passive while another owner holds the lease", async () => {
    const redis = { set: vi.fn().mockResolvedValue(null), eval: vi.fn().mockResolvedValue(0) };
    await expect(acquireTelegramPollingLease(redis, "worker-b")).resolves.toBe(false);
    expect(redis.eval).toHaveBeenCalledOnce();
  });
});
