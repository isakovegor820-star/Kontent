/** Shared admission guard for stored drafts, including failures from older releases. */
export function articleHasQualityBlock(article) {
  if (!String(article?.title || "").trim()
    || !String(article?.bodyMarkdown ?? article?.body_markdown ?? "").trim()) return true;
  const reason = article?.statusReason ?? article?.status_reason;
  if (["quality", "quality_after_edit", "article_quality_failed"].includes(reason)) return true;
  return Array.isArray(article?.quality?.issues)
    && article.quality.issues.some((issue) => issue?.severity === "error");
}
