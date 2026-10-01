import type { SessionUser } from "./session";

function positiveIds(value: string | undefined): Set<number> {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isSafeInteger(item) && item > 0),
  );
}

function normalizedEmails(value: string | undefined): Set<string> {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.includes("@") && item.length <= 320),
  );
}

/**
 * Регистрация не подтверждает владение почтой, поэтому allowlist по email сам по себе
 * позволял любому зарегистрировать allowlist-адрес и получить глобальный админ.
 * Путь по email включается только явным операторским флагом после того, как оператор
 * вручную подтвердил, что указанные аккаунты принадлежат доверенным владельцам.
 * Основной допуск — AURORA_ADMIN_USER_IDS.
 */
export function adminEmailAccessEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.AURORA_ADMIN_ALLOW_EMAILS ?? "").trim() === "1";
}

export function adminAccessConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return positiveIds(env.AURORA_ADMIN_USER_IDS).size > 0
    || (adminEmailAccessEnabled(env) && normalizedEmails(env.AURORA_ADMIN_EMAILS).size > 0);
}

/**
 * Global administration is deliberately separate from project roles. A project owner
 * may manage their own workspace, but only an explicit server-side allowlist may read
 * cross-project operational data.
 */
export function hasAuroraAdminAccess(
  user: Pick<SessionUser, "id" | "email">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (positiveIds(env.AURORA_ADMIN_USER_IDS).has(user.id)) return true;
  if (!adminEmailAccessEnabled(env)) return false;
  const email = String(user.email || "").trim().toLowerCase();
  return Boolean(email && normalizedEmails(env.AURORA_ADMIN_EMAILS).has(email));
}
