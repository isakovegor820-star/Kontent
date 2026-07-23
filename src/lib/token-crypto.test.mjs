// Тесты шифрования токенов (AES-256-GCM, AAD = user_id:provider, key_id).
// Ключ читается из env на каждый вызов (не кэшируется), поэтому «чужой ключ»
// проверяется простой сменой TOKENS_MASTER_KEY между шифровкой и расшифровкой.
import { describe, it, expect, beforeEach } from "vitest";
import { encryptToken, decryptToken } from "./token-crypto.mjs";

const CTX = { userId: 42, provider: "vk" };

beforeEach(() => {
  process.env.TOKENS_MASTER_KEY = "test-master-key";
  process.env.TOKENS_KEY_ID = "1";
});

describe("encryptToken / decryptToken", () => {
  it("roundtrip: токен возвращается без изменений", () => {
    const token = "vk1.a.secret-community-token";
    const envelope = encryptToken(token, CTX);
    expect(decryptToken(envelope, CTX)).toBe(token);
  });

  it("конверт формата v1:<keyId>:<iv>:<authTag>:<ciphertext>", () => {
    const envelope = encryptToken("x", CTX);
    const parts = envelope.split(":");
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe("v1");
    expect(parts[1]).toBe("1");
  });

  it("одинаковый токен даёт разные конверты (случайный IV)", () => {
    expect(encryptToken("same", CTX)).not.toBe(encryptToken("same", CTX));
  });

  it("чужой user (другой AAD) — не расшифровывается", () => {
    const envelope = encryptToken("secret", CTX);
    expect(() => decryptToken(envelope, { userId: 999, provider: "vk" })).toThrow();
  });

  it("чужой provider (другой AAD) — не расшифровывается", () => {
    const envelope = encryptToken("secret", CTX);
    expect(() => decryptToken(envelope, { userId: 42, provider: "tg" })).toThrow();
  });

  it("смена мастер-ключа — не расшифровывается", () => {
    const envelope = encryptToken("secret", CTX);
    process.env.TOKENS_MASTER_KEY = "another-master-key";
    expect(() => decryptToken(envelope, CTX)).toThrow();
  });

  it("подмена шифртекста (tamper) — не расшифровывается", () => {
    const parts = encryptToken("secret", CTX).split(":");
    // Меняем последний символ шифртекста на противоположный.
    const ct = parts[4];
    const flipped = (ct[0] === "0" ? "1" : "0") + ct.slice(1);
    parts[4] = flipped;
    expect(() => decryptToken(parts.join(":"), CTX)).toThrow();
  });

  it("битый конверт — throw", () => {
    expect(() => decryptToken("garbage", CTX)).toThrow();
    expect(() => decryptToken("v2:1:aa:bb:cc", CTX)).toThrow();
  });

  it("нет мастер-ключа — явный throw", () => {
    delete process.env.TOKENS_MASTER_KEY;
    expect(() => encryptToken("x", CTX)).toThrow(/TOKENS_MASTER_KEY/);
  });
});
