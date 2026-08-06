import { beforeEach, describe, expect, it, vi } from "vitest";

import { decryptToken, encryptToken, tokenEnvelopeKeyId } from "./token-crypto.mjs";
import { reencryptTokenBatch } from "./token-reencryption.mjs";

function harness(envelope, failUpdate = false) {
  let stored = envelope;
  const commands = [];
  const client = {
    query: vi.fn(async (sql, params = []) => {
      const normalized = sql.trim().toLowerCase();
      commands.push(normalized.split(/\s+/u)[0]);
      if (normalized.startsWith("select") && normalized.includes("from channels")) {
        return tokenEnvelopeKeyId(stored) === params[0]
          ? { rows: [] }
          : { rows: [{ id: 1, user_id: 7, provider: "vk", envelope: stored }] };
      }
      if (normalized.startsWith("select")) return { rows: [] };
      if (normalized.startsWith("update channels")) {
        if (failUpdate) throw new Error("fault_during_reencryption");
        if (stored !== params[2]) return { rowCount: 0, rows: [] };
        stored = params[1];
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: null, rows: [] };
    }),
    release: vi.fn(),
  };
  return {
    pool: { connect: vi.fn(async () => client) },
    client,
    commands,
    stored: () => stored,
  };
}

beforeEach(() => {
  process.env.TOKENS_MASTER_KEY = "old-secret";
  process.env.TOKENS_KEY_ID = "old";
  delete process.env.TOKENS_OLD_KEYS;
});

describe("token envelope batch rotation", () => {
  it("re-encrypts an old envelope once and is idempotent", async () => {
    const oldEnvelope = encryptToken("provider-token", { userId: 7, provider: "vk" });
    process.env.TOKENS_MASTER_KEY = "new-secret";
    process.env.TOKENS_KEY_ID = "new";
    process.env.TOKENS_OLD_KEYS = JSON.stringify({ old: "old-secret" });
    const h = harness(oldEnvelope);
    await expect(reencryptTokenBatch({ pool: h.pool, batchSize: 10 }))
      .resolves.toMatchObject({ currentKeyId: "new", reencrypted: 1 });
    expect(tokenEnvelopeKeyId(h.stored())).toBe("new");
    expect(decryptToken(h.stored(), { userId: 7, provider: "vk" })).toBe("provider-token");
    await expect(reencryptTokenBatch({ pool: h.pool, batchSize: 10 }))
      .resolves.toMatchObject({ reencrypted: 0 });
  });

  it("rolls back the batch on an update fault", async () => {
    const oldEnvelope = encryptToken("provider-token", { userId: 7, provider: "vk" });
    process.env.TOKENS_MASTER_KEY = "new-secret";
    process.env.TOKENS_KEY_ID = "new";
    process.env.TOKENS_OLD_KEYS = JSON.stringify({ old: "old-secret" });
    const h = harness(oldEnvelope, true);
    await expect(reencryptTokenBatch({ pool: h.pool, batchSize: 10 }))
      .rejects.toThrow("fault_during_reencryption");
    expect(h.commands).toContain("rollback");
    expect(h.stored()).toBe(oldEnvelope);
  });
});
