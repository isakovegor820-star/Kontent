import { randomUUID } from "node:crypto";

export const TELEGRAM_POLLING_LEASE_KEY = "aurora:worker:telegram-polling:lease:v1";
export const TELEGRAM_POLLING_LEASE_TTL_SECONDS = 90;
export const TELEGRAM_POLLING_LEASE_RENEW_MS = 20_000;

const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('expire', KEYS[1], ARGV[2])
end
return 0`;

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

export function createTelegramPollingLeaseOwner() {
  return randomUUID();
}

export async function renewTelegramPollingLease(redis, owner) {
  if (!owner) return false;
  const renewed = await redis.eval(
    RENEW_SCRIPT,
    1,
    TELEGRAM_POLLING_LEASE_KEY,
    owner,
    TELEGRAM_POLLING_LEASE_TTL_SECONDS,
  );
  return Number(renewed) === 1;
}

export async function acquireTelegramPollingLease(redis, owner) {
  if (!owner) return false;
  const claimed = await redis.set(
    TELEGRAM_POLLING_LEASE_KEY,
    owner,
    "EX",
    TELEGRAM_POLLING_LEASE_TTL_SECONDS,
    "NX",
  );
  if (claimed === "OK") return true;
  return renewTelegramPollingLease(redis, owner);
}

export async function releaseTelegramPollingLease(redis, owner) {
  if (!owner) return false;
  const released = await redis.eval(
    RELEASE_SCRIPT,
    1,
    TELEGRAM_POLLING_LEASE_KEY,
    owner,
  );
  return Number(released) === 1;
}
