export const AVATAR_INGRESS_LIMIT_ENV: "AURORA_AVATAR_BODY_LIMIT_BYTES";
export function avatarIngressConfigured(env?: NodeJS.ProcessEnv): boolean;
export function assertAvatarIngressConfigured(env?: NodeJS.ProcessEnv): void;
