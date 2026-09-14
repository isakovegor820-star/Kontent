import type { Pool } from "pg";
export const RSS_POST_SPACING_MS: number;
export const RSS_CHANNEL_MAX_POSTS_PER_DAY: number;
export const RSS_IRRELEVANT_MARKER: string;
export interface RssPipelineOptions {
  pool: Pick<Pool, "query">;
  userId?: number | null;
  projectId?: number | null;
  channelId?: number | null;
  enqueuePost: (
    userId: number, channelId: number, text: string, scheduledAt: string,
    source: { rssItemId: number; feedId: number; aiUsageReservationId: number | null },
  ) => Promise<number | string | { postId: number | string; aiUsageCommitted?: boolean; rssLinked?: boolean }>;
  summarize?: (item: Record<string, unknown>, feed: Record<string, unknown>) => Promise<string | {
    text: string;
    usage?: { reservationId: number; commit(): Promise<boolean>; finish?(committed: boolean): Promise<void> };
  } | null>;
  fetchFn?: (url: string, options?: Record<string, unknown>) => Promise<Pick<Response, "ok" | "text" | "headers">>;
  now?: () => number;
  logger?: Pick<Console, "error" | "log">;
}
export function collectRssPipeline(input: RssPipelineOptions): Promise<{ feeds: number; posts: number }>;
