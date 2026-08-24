export class BoundedBodyError extends Error {
  constructor(public readonly code: "too_large" | "missing_body" | "upload_busy") {
    super(code);
    this.name = "BoundedBodyError";
  }
}

// Auth and other public forms use stricter route-specific limits. This default still
// accommodates the product's 50k-character editor payloads in worst-case UTF-8.
export const DEFAULT_JSON_BODY_MAX_BYTES = 256 * 1024;

export type JsonBodyReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: "bad_request" | "payload_too_large"; status: 400 | 413 };

type JsonBodyRequest = {
  body: ReadableStream<Uint8Array<ArrayBufferLike>> | null;
  headers: Pick<Headers, "get">;
};

export class JsonBodyReadError extends SyntaxError {
  constructor(
    public readonly code: "bad_request" | "payload_too_large",
    public readonly status: 400 | 413,
  ) {
    super(code);
    this.name = "JsonBodyReadError";
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

/**
 * Parses a JSON request without allowing Request.json() to buffer an unbounded body.
 * The Content-Length check is only an early rejection; the streaming limit remains
 * authoritative for chunked requests and dishonest/missing headers.
 */
export async function readJsonBodyLimited<T = unknown>(
  request: JsonBodyRequest,
  maxBytes = DEFAULT_JSON_BODY_MAX_BYTES,
): Promise<JsonBodyReadResult<T>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("invalid_json_body_limit");
  }

  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader != null && contentLengthHeader.trim() !== "") {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return { ok: false, error: "payload_too_large", status: 413 };
    }
  }

  let bytes: Uint8Array;
  try {
    bytes = await readRequestBodyLimited(request.body, maxBytes);
  } catch (error) {
    if (error instanceof BoundedBodyError && error.code === "too_large") {
      return { ok: false, error: "payload_too_large", status: 413 };
    }
    if (error instanceof BoundedBodyError && error.code === "missing_body") {
      return { ok: false, error: "bad_request", status: 400 };
    }
    throw error;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    return { ok: false, error: "bad_request", status: 400 };
  }
}

/** Drop-in bounded replacement for Request.json(). */
export async function readJsonBodyValue<T = Awaited<ReturnType<Request["json"]>>>(
  request: JsonBodyRequest,
  maxBytes = DEFAULT_JSON_BODY_MAX_BYTES,
): Promise<T> {
  const result = await readJsonBodyLimited<T>(request, maxBytes);
  if (!result.ok) throw new JsonBodyReadError(result.error, result.status);
  return result.value;
}
