export class SafeHttpError extends Error {
  readonly code: string;
  readonly byteLength?: number;
}

export function isPublicAddress(address: string): boolean;
export function parsePublicHttpUrl(value: unknown): URL;
export function resolvePublicTarget(url: URL, lookupFn?: unknown): Promise<{ address: string; family: number }>;
export function validatePublicRedirect(value: string, fromUrl: URL, validateRedirect?: unknown): URL;

export interface SafeHttpResponse {
  ok: boolean;
  status: number;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  byteLength: number;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
}

export function fetchPublicText(
  value: string,
  options?: {
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
    headers?: Record<string, string>;
    lookupFn?: unknown;
    validateRedirect?: unknown;
    requestFn?: unknown;
  },
): Promise<SafeHttpResponse>;

export function fetchPublicBuffer(
  value: string,
  options?: {
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
    headers?: Record<string, string>;
    httpsOnly?: boolean;
    lookupFn?: unknown;
    validateRedirect?: unknown;
    requestFn?: unknown;
  },
): Promise<{ ok: boolean; status: number; url: string; headers: Record<string, string | string[] | undefined>; buffer: Buffer }>;
