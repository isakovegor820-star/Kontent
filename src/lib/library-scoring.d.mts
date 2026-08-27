export const LIBRARY_FORMULA_VERSION: "aurora-library-v1";
export const LIBRARY_FORMULA_DEFAULTS: Readonly<{
  bayesK: number;
  halfLifeHours: number;
  windowHours: number;
  maturityHours: number;
  minCohortSize: number;
  minMedianViews: number;
  hitPercentile: number;
  hitMinLift: number;
  epsilon: number;
}>;

export type LibraryScoringInput = {
  id: string | number;
  channelId?: string | number;
  channel_id?: string | number;
  sourceId?: string | number;
  source_id?: string | number;
  competitorId?: string | number;
  competitor_id?: string | number;
  postedAt?: string | Date;
  posted_at?: string | Date;
  views?: number | string | null;
  reactions?: number | string | null;
  format?: string | null;
  media?: string | null;
  [key: string]: unknown;
};

export type LibraryScoredItem = LibraryScoringInput & {
  channelId: string;
  sourceId: string;
  format: "text" | "photo" | "video";
  postedAt: string;
  ageHours: number;
  medianViews: number | null;
  meanEr: number | null;
  lift: number | null;
  erBayes: number | null;
  velocity: number | null;
  velocityZ: number | null;
  freshness: number;
  score: number | null;
  percentiles: Record<string, number | null>;
  missingMetrics: string[];
  availableWeight: number;
  formulaVersion: string;
  cohortKey: string;
  cohortSampleSize: number;
  cohortWindowFrom: string;
  cohortWindowTo: string;
  dataQuality: "low" | "medium" | "high";
  dataMaturity: "collecting" | "mature";
  hitThreshold: number | null;
  isHit: boolean;
};

export type LibraryScoreExplanationInput = {
  score: number | null;
  format: "text" | "photo" | "video";
  lift: number | null;
  erBayes: number | null;
  velocity: number | null;
  freshness: number | null;
  formulaVersion: string;
  missingMetrics: string[];
};

export function libraryMedian(values: unknown[]): number | null;
export function libraryQuantile(values: unknown[], proportion: number): number | null;
export function libraryPercentileRank(values: unknown[], target: unknown): number | null;
export function normalizeLibraryFormat(media: unknown): "text" | "photo" | "video";
export function scoreLibraryCohorts(
  rows: LibraryScoringInput[],
  options?: Record<string, unknown>,
): LibraryScoredItem[];
export function explainLibraryScore(item: LibraryScoreExplanationInput | null | undefined): string;
