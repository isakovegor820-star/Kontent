import { createHash } from "node:crypto";

import sharp from "sharp";

import {
  PROFILE_AVATAR_ACCEPTED_TYPES,
  PROFILE_AVATAR_UPLOAD_MAX_BYTES,
} from "./profile-avatar-contract.mjs";

export {
  PROFILE_AVATAR_ACCEPTED_TYPES,
  PROFILE_AVATAR_MULTIPART_MAX_BYTES,
  PROFILE_AVATAR_UPLOAD_MAX_BYTES,
} from "./profile-avatar-contract.mjs";

const MAX_INPUT_PIXELS = 40_000_000;
const OUTPUT_SIZE = 512;
const DECODED_FORMATS = new Set(["jpeg", "png", "webp"]);

export type ProfileAvatarErrorCode = "unsupported_type" | "too_large" | "invalid_image";

export class ProfileAvatarError extends Error {
  readonly code: ProfileAvatarErrorCode;

  constructor(code: ProfileAvatarErrorCode) {
    super(code);
    this.name = "ProfileAvatarError";
    this.code = code;
  }
}

export async function prepareProfileAvatar(
  value: ArrayBuffer | Uint8Array | Buffer,
  declaredType: string,
): Promise<{ data: Buffer; mimeType: "image/webp"; sha256: string; fileName: string }> {
  if (!(PROFILE_AVATAR_ACCEPTED_TYPES as readonly string[]).includes(declaredType)) {
    throw new ProfileAvatarError("unsupported_type");
  }
  const input = Buffer.isBuffer(value)
    ? value
    : value instanceof ArrayBuffer
      ? Buffer.from(value)
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (input.byteLength === 0) throw new ProfileAvatarError("invalid_image");
  if (input.byteLength > PROFILE_AVATAR_UPLOAD_MAX_BYTES) {
    throw new ProfileAvatarError("too_large");
  }

  try {
    const source = sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS }).rotate();
    const metadata = await source.metadata();
    if (
      !metadata.format ||
      !DECODED_FORMATS.has(metadata.format) ||
      !metadata.width ||
      !metadata.height ||
      Number(metadata.pages ?? 1) > 1
    ) {
      throw new ProfileAvatarError("invalid_image");
    }
    const data = await source
      .resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: "cover", position: "attention" })
      .webp({ quality: 86, alphaQuality: 90, effort: 5 })
      .toBuffer();
    const sha256 = createHash("sha256").update(data).digest("hex");
    return {
      data,
      mimeType: "image/webp",
      sha256,
      fileName: `profile-avatar-${sha256.slice(0, 16)}.webp`,
    };
  } catch (error) {
    if (error instanceof ProfileAvatarError) throw error;
    throw new ProfileAvatarError("invalid_image");
  }
}
