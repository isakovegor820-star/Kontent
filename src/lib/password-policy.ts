export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

export type PasswordProblem = "too_short" | "too_long" | "whitespace_only";

/**
 * Passwords are opaque credentials: never trim or normalize the value before hashing.
 * The policy only rejects an all-whitespace secret while preserving intentional spaces.
 */
export function validatePassword(password: string): PasswordProblem | undefined {
  if (password.length < PASSWORD_MIN) return "too_short";
  if (password.length > PASSWORD_MAX) return "too_long";
  if (password.trim().length === 0) return "whitespace_only";
  return undefined;
}

export function passwordProblemMessage(problem: PasswordProblem): string {
  if (problem === "too_long") return `Используйте не больше ${PASSWORD_MAX} символов.`;
  if (problem === "whitespace_only") return "Добавьте хотя бы один непробельный символ.";
  return `Используйте не меньше ${PASSWORD_MIN} символов.`;
}
