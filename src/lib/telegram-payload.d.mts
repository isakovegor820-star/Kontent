export const TELEGRAM_TEXT_LIMIT: 4096;
export const TELEGRAM_CAPTION_LIMIT: 1024;

export interface TelegramPayloadPart {
  index: number;
  type: "text" | "media" | "media_caption";
  payloadHtml: string | null;
  entityLength: number;
}

export function parseTelegramHtml(html: string): Array<{
  html: string;
  text: string;
  length: number;
  styles: Array<"b" | "spoiler">;
}>;
export function telegramEntityLength(html: string): number;
export function splitTelegramHtml(
  html: string,
  limit?: number,
): Array<{ html: string; entityLength: number }>;
export function telegramHtmlToText(html: string): string;
export function buildTelegramPayload(input: {
  text: string;
  hasAsset?: boolean;
  forceSeparateMedia?: boolean;
}): {
  formattedText: string;
  formattedHtml: string;
  entityLength: number;
  parts: TelegramPayloadPart[];
};
