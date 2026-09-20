import type { Pool } from 'pg';
export const RSS_POST_SPACING_MS: number;
export const RSS_CHANNEL_MAX_POSTS_PER_DAY: number;
export const RSS_IRRELEVANT_MARKER: string;
export function collectRssPipeline(options: {
  pool: Pick<Pool,'query'>;
  enqueuePost: (...args: unknown[]) => unknown;
  summarize?: (...args: unknown[]) => unknown;
  userId?: number|null;
  channelId?: number|null;
  projectId?: number|null;
  fetchFn?: (url:string,options:Record<string,unknown>) => Promise<{ok:boolean;text:()=>Promise<string>}>;
  now?:()=>number;
  logger?:Pick<Console,'log'|'error'>;
}):Promise<{feeds:number;posts:number}>;
