export function phoneVerificationMode(env = process.env) {
  return env.NODE_ENV === "production" ? "unavailable" : "temporary";
}
