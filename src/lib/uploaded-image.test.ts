import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { inspectUploadedImage } from "./uploaded-image";

const TRUNCATED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4kAAAAAASUVORK5CYII=",
  "base64",
);

describe("проверка загружаемого изображения", () => {
  it("отклоняет PNG с правдоподобным заголовком, но повреждёнными пикселями", async () => {
    await expect(inspectUploadedImage(TRUNCATED_PNG)).rejects.toThrow("Файл изображения повреждён или не поддерживается");
  });

  it("принимает полностью читаемый файл и возвращает его размеры", async () => {
    const valid = await sharp({
      create: { width: 8, height: 6, channels: 4, background: { r: 49, g: 87, b: 213, alpha: 1 } },
    }).png().toBuffer();

    await expect(inspectUploadedImage(valid)).resolves.toEqual({ format: "png", width: 8, height: 6 });
  });
});
