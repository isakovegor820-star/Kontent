import type { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export const SITE_ARTICLE_FIELDS: string;
export function articleContentHash(article: Record<string, unknown>): string;
export function recordArticleRevision(db: Queryable, input: { article: Record<string, unknown>; version: number | string; authorUserId?: number | null; changeKind: "generated" | "edited" | "approved" | "rejected" | "published" | "retired" }): Promise<void>;
export function nextUniqueSlug(db: Queryable, input: { siteId: number; base: string; excludeArticleId?: number | null }): Promise<string>;
export function publicationIdempotencyKey(input: { articleId: number | string; destinationId: number | string; version: number | string; action?: string }): string;
export function createArticlePublications(db: Queryable, input: { article: { id: number | string; version: number | string }; destinations: Array<{ id: number | string }>; action?: "publish" | "update" | "unpublish" }): Promise<Array<{ id: number | string; article_id: number | string; destination_id: number | string; article_version: number | string; idempotency_key: string; action: string; status: string }>>;
export function activeDestinationsForSite(db: Queryable, siteId: number): Promise<Array<Record<string, unknown> & { id: number | string; kind: string }>>;
export function articlePayload(article: Record<string, unknown>, options?: { publishAt?: string | null }): Record<string, unknown>;
export function articleTypeLabel(type: string): string;
export function applyApprovalStreak(db: Queryable, input: { siteId: number; edited: boolean; rejected: boolean }): Promise<void>;
