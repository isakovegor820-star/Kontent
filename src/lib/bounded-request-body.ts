export class BoundedBodyError extends Error {
  constructor(public readonly code: "too_large" | "missing_body" | "upload_busy") {
    super(code);
    this.name = "BoundedBodyError";
  }
}

let activeAvatarBodies = 0;
let activeMediaAssetBodies = 0;
export const MAX_CONCURRENT_AVATAR_BODIES = 4;
export const MAX_CONCURRENT_MEDIA_ASSET_BODIES = 2;

export function acquireAvatarBodySlot() {
  if (activeAvatarBodies >= MAX_CONCURRENT_AVATAR_BODIES) {
    throw new BoundedBodyError("upload_busy");
  }
  activeAvatarBodies += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeAvatarBodies = Math.max(0, activeAvatarBodies - 1);
  };
}

/** Media images can decode to tens of millions of pixels, so their budget is stricter. */
export function acquireMediaAssetBodySlot() {
  if (activeMediaAssetBodies >= MAX_CONCURRENT_MEDIA_ASSET_BODIES) {
    throw new BoundedBodyError("upload_busy");
  }
  activeMediaAssetBodies += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeMediaAssetBodies = Math.max(0, activeMediaAssetBodies - 1);
  };
}

/** Reads at most maxBytes and cancels the source before multipart parsing can allocate more. */
export async function readRequestBodyLimited(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!stream) throw new BoundedBodyError("missing_body");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("body_limit_exceeded").catch(() => {});
        throw new BoundedBodyError("too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
