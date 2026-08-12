import sharp from "sharp";

const MAX_INPUT_PIXELS = 40_000_000;

export type UploadedImageInfo = {
  format: "jpeg" | "png" | "webp";
  width: number;
  height: number;
};

export class InvalidUploadedImageError extends Error {
  constructor() {
    super("Файл изображения повреждён или не поддерживается");
    this.name = "InvalidUploadedImageError";
  }
}

/**
 * Читает не только заголовок, но и данные изображения. Повреждённый файл
 * должен быть отклонён при загрузке, а не во время последующей сборки макета.
 */
export async function inspectUploadedImage(buffer: Buffer): Promise<UploadedImageInfo | null> {
  try {
    const source = sharp(buffer, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS });
    const metadata = await source.metadata();
    if (
      !metadata.width
      || !metadata.height
      || !["jpeg", "png", "webp"].includes(metadata.format ?? "")
    ) return null;

    // Маленький выход ограничивает память, но заставляет библиотеку полностью
    // прочитать исходные пиксели и тем самым обнаружить обрезанный файл.
    await source.clone().rotate().resize(1, 1, { fit: "inside" }).raw().toBuffer();
    return {
      format: metadata.format as UploadedImageInfo["format"],
      width: metadata.width,
      height: metadata.height,
    };
  } catch {
    throw new InvalidUploadedImageError();
  }
}
