export function escapeHtml(value: unknown): string;
export function slugify(value: unknown, options?: { maxLength?: number }): string;
export function renderMarkdown(markdown: unknown): string;
export function markdownToText(markdown: unknown): string;
export function extractLinks(markdown: unknown): Array<{ anchor: string; url: string }>;
export function countWords(text: unknown): number;
