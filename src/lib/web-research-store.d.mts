import type { Pool, PoolClient } from "pg";

export type WebResearchQueryable = Pick<Pool | PoolClient, "query">;
export type WebResearchScope = { projectId: number; channelId: number };

export type WebResearchFindingKind = "law" | "benchmark" | "market" | "statistics" | "event" | "statement";
export type WebResearchFindingStatus = "new" | "used" | "dismissed";
export type WebResearchTriggerKind = "manual" | "schedule" | "autopilot" | "today" | "chat" | "growth" | "opportunity";
export type WebResearchSourceTier = "official" | "professional" | "research" | "media" | "open";

export type WebResearchFinding = {
  fingerprint: string;
  kind: WebResearchFindingKind;
  claim: string;
  quote: string;
  title: string | null;
  language: "RU" | "EN";
  legalStatus: string | null;
  legalStatusLabel: string | null;
  source: {
    url: string;
    domain: string;
    label: string;
    tier: WebResearchSourceTier;
    tierLabel: string;
    trust: number;
    registered: boolean;
  };
  publishedAt: string;
  retrievedAt: string;
  ageDays: number;
  numbers: string[];
  corroboratingDomains: string[];
  corroborationCount: number;
  trusted: boolean;
};

export type WebResearchStoredFinding = WebResearchFinding & {
  id: number;
  runId: number | null;
  status: WebResearchFindingStatus;
};

export type WebResearchRunQuery = { id: string; text: string; category: string; siteScoped: boolean; language?: string };

export type WebResearchRunRow = {
  id: number;
  triggerKind: WebResearchTriggerKind;
  topic: string;
  categories: string[];
  language: string;
  status: "running" | "completed" | "failed";
  planFingerprint: string;
  queries: WebResearchRunQuery[];
  log: Array<{ step: string; message: string; detail: Record<string, unknown> | null; at: string }>;
  stats: Record<string, unknown>;
  findingsCount: number;
  rejectionsCount: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
};

export type StartWebResearchRunInput = {
  triggerKind?: WebResearchTriggerKind;
  topic: string;
  categories: string[];
  language: string;
  planFingerprint: string;
  queries: WebResearchRunQuery[];
};

export class WebResearchStoreError extends Error {
  readonly code: "bad_scope" | "bad_run" | "bad_status";
}

export function startWebResearchRun(
  db: WebResearchQueryable, scope: WebResearchScope, input: StartWebResearchRunInput,
): Promise<number>;

export function finishWebResearchRun(
  db: WebResearchQueryable,
  runId: number,
  input: {
    status: "completed" | "failed";
    log: unknown[];
    stats: Record<string, unknown>;
    findingsCount: number;
    rejectionsCount: number;
    error?: string | null;
  },
): Promise<void>;

export function persistWebResearchFindings(
  db: WebResearchQueryable, scope: WebResearchScope, runId: number | null, findings: WebResearchFinding[],
): Promise<number>;

export function loadWebResearchFindings(
  db: WebResearchQueryable,
  scope: WebResearchScope,
  options?: {
    limit?: number;
    kinds?: WebResearchFindingKind[];
    statuses?: WebResearchFindingStatus[];
    maxAgeDays?: number;
  },
): Promise<WebResearchStoredFinding[]>;

export function markWebResearchFindings(
  db: WebResearchQueryable, scope: WebResearchScope, fingerprints: string[], status: WebResearchFindingStatus,
): Promise<number>;

export function latestWebResearchRun(db: WebResearchQueryable, scope: WebResearchScope): Promise<WebResearchRunRow | null>;

export function getWebResearchRun(
  db: WebResearchQueryable, runId: number,
): Promise<{
  id: number; projectId: number; channelId: number; triggerKind: WebResearchTriggerKind;
  status: string; planFingerprint: string; queries: WebResearchRunQuery[];
} | null>;

export function findReusableWebResearchRun(
  db: WebResearchQueryable, scope: WebResearchScope, planFingerprint: string, options?: { maxAgeMinutes?: number },
): Promise<{ runId: number; findings: WebResearchStoredFinding[] } | null>;
