// Пароли. Храним только необратимый хеш (scrypt из стандартной библиотеки Node —
// без внешних зависимостей, ТЗ 8.2). Формат строки: "<saltHex>:<hashHex>".
// Никогда не логируем и не возвращаем пароль или хеш наружу.

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const KEYLEN = 64; // длина производного ключа в байтах

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
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const derived = await scryptAsync(password, salt);
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

// Требования к паролю: не короче 8 символов (простая, честная планка — не мучаем человека
// спецсимволами), не длиннее 200 (защита от абсурдно длинного ввода).
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

/** Проверяет пароль на длину. Возвращает текст ошибки или undefined. */
export function validatePassword(password: string): string | undefined {
  if (password.length < PASSWORD_MIN) return `Пароль — минимум ${PASSWORD_MIN} символов.`;
  if (password.length > PASSWORD_MAX) return "Слишком длинный пароль.";
  return undefined;
}
