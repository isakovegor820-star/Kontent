// Пароли. Храним только необратимый хеш (scrypt из стандартной библиотеки Node —
// без внешних зависимостей, ТЗ 8.2). Формат строки: "<saltHex>:<hashHex>".
// Никогда не логируем и не возвращаем пароль или хеш наружу.

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
export {
  PASSWORD_MAX,
  PASSWORD_MIN,
  passwordProblemMessage,
  validatePassword,
  type PasswordProblem,
} from "./password-policy";

const KEYLEN = 64; // длина производного ключа в байтах
const DUMMY_SALT = Buffer.alloc(16);
const DUMMY_EXPECTED = Buffer.alloc(KEYLEN);

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEYLEN, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/** Хеширует пароль со случайной солью. Результат — "<saltHex>:<hashHex>". */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

/** Сверяет пароль с сохранённым хешем. Сравнение — constant-time. */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const [saltHex, hashHex, extra] = String(stored ?? "").split(":");
  const validStored = extra === undefined
    && /^[a-f0-9]{32}$/iu.test(saltHex ?? "")
    && /^[a-f0-9]{128}$/iu.test(hashHex ?? "");
  // Unknown accounts and malformed legacy rows must pay the same scrypt cost as a
  // normal wrong password; otherwise response latency becomes an email oracle.
  const salt = validStored ? Buffer.from(saltHex, "hex") : DUMMY_SALT;
  const expected = validStored ? Buffer.from(hashHex, "hex") : DUMMY_EXPECTED;
  const derived = await scryptAsync(password, salt);
  const matches = timingSafeEqual(derived, expected);
  return validStored && matches;
}
