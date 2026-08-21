import type { PostQuality } from "./post-quality.mjs";

export function normalizePostForm(text: string, quality: Partial<PostQuality> | null | undefined): string;
export function reservedFormChars(text: string, quality: Partial<PostQuality> | null | undefined): number;
export function finishPostForm(text: string, quality: Partial<PostQuality> | null | undefined): string;
