export const SITE_ARTICLE_PROMPT_VERSION: string;
export function buildArticlePrompt(input: Record<string, unknown>): Readonly<{ system: string; user: string; promptVersion: string }>;
export function parseArticleGeneration(text: string): Record<string, unknown>;
export type ArticleValidationIssue = { code: string; severity: "error" | "warning"; message: string; urls?: string[] };
export function validateArticle(
  article: { title?: string; metaDescription?: string | null; bodyMarkdown?: string; faq?: unknown; organization?: unknown },
  options: { type: string; allowedLinks?: string[]; sourceUrl?: string | null; site?: Record<string, unknown> },
): {
  ok: boolean;
  issues: ArticleValidationIssue[];
  article: {
    title: string;
    slug: string;
    metaDescription: string;
    bodyMarkdown: string;
    bodyHtml: string;
    internalLinks: Array<{ url: string; anchor: string }>;
    structuredData: Record<string, unknown> | null;
    wordCount: number;
  };
};
