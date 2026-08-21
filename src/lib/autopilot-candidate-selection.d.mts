export interface AutopilotCandidate {
  i?: number;
  topic?: string;
  draft?: string;
  news?: boolean;
  sourceConfirmed?: boolean;
  qualityScore?: number;
  quality?: { score?: number };
  [key: string]: unknown;
}

export function autopilotCandidateCount(publicationCount: unknown): number;
export function selectAutopilotCandidates(
  candidates: AutopilotCandidate[],
  options?: { targetCount?: unknown; newsQuota?: unknown },
): {
  selected: AutopilotCandidate[];
  reserve: AutopilotCandidate[];
  targetCount: number;
  candidateCount: number;
  newsQuota: number;
  selectedNewsCount: number;
  newsQuotaSatisfied: boolean;
  complete: boolean;
};
