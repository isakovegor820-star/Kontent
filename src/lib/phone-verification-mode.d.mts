export type PhoneVerificationMode = "temporary" | "unavailable";

export function phoneVerificationMode(env?: NodeJS.ProcessEnv): PhoneVerificationMode;
