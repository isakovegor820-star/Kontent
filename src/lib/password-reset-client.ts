export type PasswordResetRequestOutcome =
  | "accepted"
  | "rate_limited"
  | "temporarily_unavailable"
  | "failed";

/** Keep the recovery UI truthful without branching on whether an email exists. */
export function passwordResetRequestOutcome(
  status: number,
  ok: boolean,
  error?: string,
): PasswordResetRequestOutcome {
  if (ok && status === 202) return "accepted";
  if (status === 429 || error === "rate_limited") return "rate_limited";
  if (status === 503 || error === "rate_limit_unavailable") return "temporarily_unavailable";
  return "failed";
}
