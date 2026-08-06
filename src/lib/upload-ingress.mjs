import {
  PROFILE_AVATAR_MULTIPART_MAX_BYTES,
  PROFILE_AVATAR_UPLOAD_MAX_BYTES,
} from "./profile-avatar-contract.mjs";

export const AVATAR_INGRESS_LIMIT_ENV = "AURORA_AVATAR_BODY_LIMIT_BYTES";

export function avatarIngressConfigured(env = process.env) {
  if (env.NODE_ENV !== "production") return true;
  const value = Number(env[AVATAR_INGRESS_LIMIT_ENV]);
  return Number.isSafeInteger(value)
    && value >= PROFILE_AVATAR_UPLOAD_MAX_BYTES
    && value <= PROFILE_AVATAR_MULTIPART_MAX_BYTES;
}

export function assertAvatarIngressConfigured(env = process.env) {
  if (!avatarIngressConfigured(env)) {
    throw new Error("avatar_ingress_limit_not_configured");
  }
}
