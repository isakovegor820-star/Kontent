import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { cleanGeneratedImage } from "./media-image-cleanup.mjs";

describe("generated image cleanup", () => {
  it("removes a black provider frame and returns the requested full-bleed ratio", async () => {
    const framed = await sharp({
      create: { width: 120, height: 120, channels: 3, background: "#000000" },
    })
      .composite([{
        input: await sharp({
          create: { width: 96, height: 100, channels: 3, background: "#7dcfe8" },
        }).png().toBuffer(),
        left: 12,
        top: 8,
      }])
      .jpeg({ quality: 95 })
      .toBuffer();

    const result = await cleanGeneratedImage(framed, "image/jpeg", "1:1");
    const metadata = await sharp(result.buffer).metadata();
    const corner = await sharp(result.buffer).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();

    expect(result.cleaned).toBe(true);
    expect(result.crop?.removedFrame).toBe(true);
    expect(metadata.width).toBe(metadata.height);
    expect(Math.max(...corner)).toBeGreaterThan(48);
  });

  it("does not crop a legitimate dark full-bleed image", async () => {
    const dark = await sharp({
      create: { width: 100, height: 100, channels: 3, background: "#050505" },
    }).png().toBuffer();

    const result = await cleanGeneratedImage(dark, "image/png", "1:1");
    expect(result.cleaned).toBe(false);
    expect(result.buffer).toBe(dark);
  });

  it("normalizes a provider result that ignores the requested aspect ratio", async () => {
    const image = await sharp({
      create: { width: 120, height: 100, channels: 3, background: "#72b86b" },
    }).png().toBuffer();

    const result = await cleanGeneratedImage(image, "image/png", "1:1");
    const metadata = await sharp(result.buffer).metadata();
    expect(result.cleaned).toBe(true);
    expect(metadata.width).toBe(100);
    expect(metadata.height).toBe(100);
  });
});
