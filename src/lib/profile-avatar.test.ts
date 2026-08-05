import { describe, expect, it } from "vitest";
import sharp from "sharp";

import {
  PROFILE_AVATAR_UPLOAD_MAX_BYTES,
  ProfileAvatarError,
  prepareProfileAvatar,
} from "./profile-avatar";

describe("profile avatar preparation", () => {
  it("crops, strips metadata and stores a compact square WebP", async () => {
    const source = await sharp({
      create: { width: 900, height: 600, channels: 3, background: "#6f88d8" },
    }).jpeg().withMetadata({ orientation: 1 }).toBuffer();

    const prepared = await prepareProfileAvatar(source, "image/jpeg");
    const metadata = await sharp(prepared.data).metadata();

    expect(prepared.mimeType).toBe("image/webp");
    expect(prepared.fileName).toMatch(/^profile-avatar-[a-f0-9]{16}\.webp$/u);
    expect(metadata.width).toBe(512);
    expect(metadata.height).toBe(512);
    expect(metadata.format).toBe("webp");
    expect(metadata.exif).toBeUndefined();
  });

  it("rejects unsupported, invalid and oversized files", async () => {
    await expect(prepareProfileAvatar(Buffer.from("not an image"), "image/gif"))
      .rejects.toMatchObject({ code: "unsupported_type" } satisfies Partial<ProfileAvatarError>);
    await expect(prepareProfileAvatar(Buffer.from("not an image"), "image/png"))
      .rejects.toMatchObject({ code: "invalid_image" } satisfies Partial<ProfileAvatarError>);
    await expect(prepareProfileAvatar(Buffer.alloc(PROFILE_AVATAR_UPLOAD_MAX_BYTES + 1), "image/png"))
      .rejects.toMatchObject({ code: "too_large" } satisfies Partial<ProfileAvatarError>);
  });
});
