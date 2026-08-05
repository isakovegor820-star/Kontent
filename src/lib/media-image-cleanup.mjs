import sharp from "sharp";

const BORDER_LIGHTNESS = 48;
const BORDER_PIXEL_SHARE = 0.9;
const MAX_BORDER_SHARE = 0.2;
const MAX_INPUT_PIXELS = 40_000_000;
const ASPECT_TOLERANCE = 0.005;

function requestedAspectRatio(value) {
  const match = /^([1-9][0-9]*):([1-9][0-9]*)$/u.exec(String(value || "").trim());
  if (!match) return null;
  const ratio = Number(match[1]) / Number(match[2]);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

function isBorderPixel(data, offset, channels) {
  const alpha = channels >= 4 ? data[offset + 3] : 255;
  if (alpha <= 16) return true;
  return data[offset] <= BORDER_LIGHTNESS
    && data[offset + 1] <= BORDER_LIGHTNESS
    && data[offset + 2] <= BORDER_LIGHTNESS;
}

function borderPixelShare(data, info, axis, index) {
  const length = axis === "row" ? info.width : info.height;
  let borderPixels = 0;
  for (let cursor = 0; cursor < length; cursor += 1) {
    const x = axis === "row" ? cursor : index;
    const y = axis === "row" ? index : cursor;
    const offset = (y * info.width + x) * info.channels;
    if (isBorderPixel(data, offset, info.channels)) borderPixels += 1;
  }
  return borderPixels / length;
}

function scanBorder(data, info, axis, fromEnd) {
  const size = axis === "row" ? info.height : info.width;
  const max = Math.max(1, Math.floor(size * MAX_BORDER_SHARE));
  let count = 0;
  while (count < max) {
    const index = fromEnd ? size - 1 - count : count;
    if (borderPixelShare(data, info, axis, index) < BORDER_PIXEL_SHARE) break;
    count += 1;
  }

  // A genuinely dark full-bleed scene stays black beyond the conservative scan limit.
  // It is not a frame and must not be eaten away.
  if (count === max && max < size) {
    const next = fromEnd ? size - 1 - count : count;
    if (borderPixelShare(data, info, axis, next) >= BORDER_PIXEL_SHARE) return 0;
  }
  return count;
}

function credibleFrame(borders) {
  const sides = Object.values(borders).filter((value) => value > 0).length;
  const oppositePair = (borders.left > 0 && borders.right > 0)
    || (borders.top > 0 && borders.bottom > 0);
  return sides >= 3 || oppositePair;
}

function insetDetectedFrame(width, height, borders) {
  if (!credibleFrame(borders)) return { left: 0, top: 0, width, height, framed: false };
  const bleed = Math.max(1, Math.round(Math.min(width, height) * 0.002));
  const left = Math.min(width - 1, borders.left + (borders.left > 0 ? bleed : 0));
  const top = Math.min(height - 1, borders.top + (borders.top > 0 ? bleed : 0));
  const right = Math.max(left + 1, width - borders.right - (borders.right > 0 ? bleed : 0));
  const bottom = Math.max(top + 1, height - borders.bottom - (borders.bottom > 0 ? bleed : 0));
  return { left, top, width: right - left, height: bottom - top, framed: true };
}

function fitRectToAspect(rect, ratio) {
  if (!ratio || Math.abs(rect.width / rect.height - ratio) <= ASPECT_TOLERANCE) return rect;
  if (rect.width / rect.height > ratio) {
    const width = Math.max(1, Math.round(rect.height * ratio));
    return { ...rect, left: rect.left + Math.floor((rect.width - width) / 2), width };
  }
  const height = Math.max(1, Math.round(rect.width / ratio));
  return { ...rect, top: rect.top + Math.floor((rect.height - height) / 2), height };
}

function outputPipeline(pipeline, mime) {
  if (mime === "image/jpeg") {
    return pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: 95, chromaSubsampling: "4:4:4", mozjpeg: true });
  }
  if (mime === "image/png") return pipeline.png({ compressionLevel: 9 });
  if (mime === "image/webp") return pipeline.webp({ quality: 95, effort: 5 });
  return null;
}

/**
 * Removes provider-created black/transparent frames and enforces the requested canvas ratio.
 * A conservative edge detector leaves legitimate dark full-bleed scenes untouched.
 */
export async function cleanGeneratedImage(buffer, mime, aspectRatio) {
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) {
    return { buffer: input, mime, cleaned: false, crop: null };
  }

  const source = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" }).rotate();
  const { data, info } = await source.clone().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const borders = {
    top: scanBorder(data, info, "row", false),
    right: scanBorder(data, info, "column", true),
    bottom: scanBorder(data, info, "row", true),
    left: scanBorder(data, info, "column", false),
  };
  const frameRect = insetDetectedFrame(info.width, info.height, borders);
  const crop = fitRectToAspect(frameRect, requestedAspectRatio(aspectRatio));
  const changed = crop.left !== 0
    || crop.top !== 0
    || crop.width !== info.width
    || crop.height !== info.height;
  if (!changed) return { buffer: input, mime, cleaned: false, crop: null };

  const encoder = outputPipeline(source.extract({
    left: crop.left,
    top: crop.top,
    width: crop.width,
    height: crop.height,
  }), mime);
  if (!encoder) return { buffer: input, mime, cleaned: false, crop: null };
  return {
    buffer: await encoder.toBuffer(),
    mime,
    cleaned: true,
    crop: { ...crop, removedFrame: frameRect.framed },
  };
}
