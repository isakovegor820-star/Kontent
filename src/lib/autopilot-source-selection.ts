import type { Brief } from "./brief";
import type { AutopilotNewsSource } from "./autopilot-news.mjs";
import { rankRssCatalog } from "./rss-catalog";

type SourceBrief = Pick<Brief, "niche" | "audience" | "goal" | "rubrics" | "formats">;

/**
 * Autopilot owns source selection. A confirmed brief is enough to derive a small curated
 * perimeter for both manual generation and unattended weekly plans.
 */
export function selectAutopilotNewsSources(
  brief: SourceBrief,
  limit = 6,
): AutopilotNewsSource[] {
  const context = [
    brief.niche,
    brief.audience,
    brief.goal,
    ...(Array.isArray(brief.rubrics) ? brief.rubrics : []),
    ...(Array.isArray(brief.formats) ? brief.formats : []),
  ].filter(Boolean).join(" ");

  return rankRssCatalog(context)
    .filter((source) => source.recommended)
    .slice(0, Math.max(1, Math.min(6, Math.round(Number(limit) || 6))))
    .map(({ id, title, url, category, language, score, reason }) => ({
      id,
      title,
      url,
      category,
      language,
      score,
      reason,
    }));
}
