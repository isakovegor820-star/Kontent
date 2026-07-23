// Тесты хеширования паролей (scrypt). Проверяем roundtrip, стойкость к неверному
// паролю и битому хранимому значению, а также границы validatePassword.
import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  validatePassword,
  PASSWORD_MIN,
  PASSWORD_MAX,
} from "./password";

describe("hashPassword / verifyPassword", () => {
  it("roundtrip: верный пароль проходит", async () => {
    const stored = await hashPassword("correct-horse-42");
    expect(await verifyPassword("correct-horse-42", stored)).toBe(true);
  });

  it("неверный пароль — false", async () => {
    const stored = await hashPassword("correct-horse-42");
    expect(await verifyPassword("wrong-password", stored)).toBe(false);
  });

  it("формат строки: <saltHex>:<hashHex>", async () => {
    const stored = await hashPassword("some-password");
    const parts = stored.split(":");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^[0-9a-f]{32}$/); // 16 байт соли = 32 hex
    expect(parts[1]).toMatch(/^[0-9a-f]{128}$/); // KEYLEN 64 = 128 hex
  });

  it("одинаковые пароли дают разные хеши (соль случайная)", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
  });

  it("null в stored — false", async () => {
    expect(await verifyPassword("anything", null)).toBe(false);
  });

  it("битый stored (нет двоеточия) — false", async () => {
    expect(await verifyPassword("anything", "garbage")).toBe(false);
  });

  it("битый stored (короткий хеш) — false без падения", async () => {
    expect(await verifyPassword("anything", "abcd:ef")).toBe(false);
  });
});

describe("validatePassword", () => {
  it("короче минимума — ошибка", () => {
    expect(validatePassword("a".repeat(PASSWORD_MIN - 1))).toBeDefined();
  });
  it("ровно минимум — ок", () => {
    expect(validatePassword("a".repeat(PASSWORD_MIN))).toBeUndefined();
  });
  it("ровно максимум — ок", () => {
    expect(validatePassword("a".repeat(PASSWORD_MAX))).toBeUndefined();
  });
  it("длиннее максимума — ошибка", () => {
    expect(validatePassword("a".repeat(PASSWORD_MAX + 1))).toBeDefined();
  });
});
