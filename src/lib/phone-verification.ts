import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const PHONE_CODE_TTL_MS = 10 * 60 * 1000;
export const PHONE_CODE_MAX_ATTEMPTS = 5;

export function createPhoneVerificationCode(): { code: string; encodedHash: string } {
  const code = String(Math.floor(100_000 + Math.random() * 900_000));
  const salt = randomBytes(16).toString("base64url");
  const digest = scryptSync(code, salt, 32).toString("base64url");
  return { code, encodedHash: `${salt}:${digest}` };
}

export function verifyPhoneCode(code: unknown, encodedHash: unknown): boolean {
  if (typeof code !== "string" || !/^[0-9]{6}$/u.test(code)) return false;
  if (typeof encodedHash !== "string") return false;
  const [salt, expectedEncoded, extra] = encodedHash.split(":");
  if (!salt || !expectedEncoded || extra) return false;
  try {
    const expected = Buffer.from(expectedEncoded, "base64url");
    const actual = scryptSync(code, salt, expected.byteLength);
    return expected.byteLength > 0 && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
