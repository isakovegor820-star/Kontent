export type MediaKind = "image" | "video";
export type MediaGenerationStatus =
  | "queued"
  | "submitting"
  | "generating"
  | "saving"
  | "ready"
  | "failed";

export interface MediaPromptContext {
  policy: "aurora-media-prompt";
  version: 1;
  sourcePost: string;
  visualBrief: string;
  exactText: string;
  platform: "tg" | "telegram" | "vk" | "instagram" | "youtube" | "generic";
  brandProfile: string;
  brandPalette: string[];
}

export const MEDIA_QUEUE: "media-generation";
export const MEDIA_GENERATION_STATUSES: readonly MediaGenerationStatus[];
export const MEDIA_PROMPT_POLICY: Readonly<{ id: "aurora-media-prompt"; version: 1 }>;
export const MEDIA_MODELS: Readonly<Record<MediaKind, Readonly<Record<string, Readonly<Record<string, unknown>>>>>>;
export const MEDIA_STYLES: Readonly<Record<string, string>>;

export function mediaModelAccess(
  kind: MediaKind,
  modelId: string,
  plan: string,
  catalogModel?: Record<string, unknown> | null,
): { available: boolean; reason: string | null; requiredPlan: string | null };

export function validateMediaInput(raw: unknown):
  | { ok: false; error: string; value?: undefined }
  | {
      ok: true;
      value: {
        kind: MediaKind;
        prompt: string;
        model: string;
        aspectRatio: string;
        style: string;
        negativePrompt: string;
        sourceText: string;
        exactText: string;
        channelId: number | null;
        quality?: string;
        seconds?: number;
      };
    };

export function extractExplicitBrandPalette(profile: unknown): string[];
export function buildMediaPromptContext(
  input: Record<string, unknown>,
  server?: { platform?: unknown; brandProfile?: unknown; brandPalette?: unknown },
): MediaPromptContext;
export function buildNavyMediaPayload(generation: Record<string, unknown>): Record<string, unknown>;
export function assertSafeMediaUrl(value: unknown): URL;
export function parseMediaDataUrl(
  value: unknown,
  kind: MediaKind,
  maxBytes: number,
): { mime: string; base64: string };
export function detectMediaMime(buffer: Uint8Array, header: unknown, kind: MediaKind): string;
