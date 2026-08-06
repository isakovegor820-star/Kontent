export const PROFILE_AVATAR_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const PROFILE_AVATAR_MULTIPART_MAX_BYTES = PROFILE_AVATAR_UPLOAD_MAX_BYTES + 512 * 1024;
export const PROFILE_AVATAR_ACCEPTED_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
