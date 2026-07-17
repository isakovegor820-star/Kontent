// Разбор и проверка контакта из формы заявки (Д.1).
// Один источник правды для клиента (лендинг) и сервера (/api/lead) — чтобы
// клиент и сервер не расходились в том, что считать валидной заявкой.

export type LeadKind = "email" | "telegram";

// Почта: есть @, а после него — точка и хвост ≥2 символов. Кириллические домены (.рф) проходят.
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Ник: начинается с @, дальше ≥2 непробельных символа. Кириллицу пропускаем —
// это контакт для живого человека, а не программный логин.
export const NICK = /^@[^\s@]{2,}$/;

/**
 * Разбирает сырой ввод в нормализованный контакт и его тип.
 * Возвращает null, если это не похоже ни на почту, ни на ник.
 * Нормализация: trim + нижний регистр (чтобы дубликаты не двоились в базе).
 */
export function parseContact(raw: string): { contact: string; kind: LeadKind } | null {
  const value = raw.trim();
  if (!value) return null;
  if (NICK.test(value)) return { contact: value.toLowerCase(), kind: "telegram" };
  if (EMAIL.test(value)) return { contact: value.toLowerCase(), kind: "email" };
  return null;
}

// Тексты ошибок — по ТЗ 7.5: что случилось и что нужно от тебя, без обвинений.
export const ERR_EMPTY = "Напиши почту или ник в Telegram — без этого не получится позвать тебя.";
export const ERR_SHAPE = "Похоже, это не почта и не @username — проверь, пожалуйста.";

/** Сообщение об ошибке для формы (или undefined, если контакт валиден). */
export function validateContact(raw: string): string | undefined {
  if (!raw.trim()) return ERR_EMPTY;
  if (!parseContact(raw)) return ERR_SHAPE;
  return undefined;
}
