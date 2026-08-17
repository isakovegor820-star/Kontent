export type RichTextEntityType =
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "code"
  | "spoiler"
  | "blockquote"
  | "link";

export type RichTextEntity = {
  type: RichTextEntityType;
  offset: number;
  length: number;
  url?: string;
};

export const RICH_TEXT_ENTITY_TYPES: readonly RichTextEntityType[];
export const MAX_RICH_TEXT_ENTITIES: number;
export function normalizeRichTextUrl(value: unknown): string;
export function normalizeRichTextEntities(text: string, value: unknown): RichTextEntity[];
export function sliceRichTextEntities(
  entities: readonly RichTextEntity[],
  start: number,
  end: number,
): RichTextEntity[];
export function trimRichTextContent(
  text: string,
  entities: readonly RichTextEntity[],
): { text: string; entities: RichTextEntity[] };
