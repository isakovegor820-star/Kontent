export function articleHasQualityBlock(article: {
  title?: string;
  bodyMarkdown?: string;
  body_markdown?: string;
  statusReason?: string | null;
  status_reason?: string | null;
  quality?: Record<string, unknown> | null;
}): boolean;
