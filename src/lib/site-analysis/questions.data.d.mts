export type SiteInterviewAnswerType = "text" | "boolean" | "list" | "matrix" | "metric";
export type SiteInterviewMinimumConfidence = "low" | "medium" | "high";

export type SiteInterviewQuestionData = Readonly<{
  id: string;
  version: number;
  category: string;
  title: string;
  question: string;
  purpose: string;
  answerType: SiteInterviewAnswerType;
  requiredEvidence: readonly string[];
  allowedSourceKinds: readonly string[];
  minimumConfidence: SiteInterviewMinimumConfidence;
  required: boolean;
  recommendationDimensions: readonly string[];
}>;
export const SITE_INTERVIEW_CATALOG_VERSION: "site-osint-questions-v1";
export const SITE_INTERVIEW_CATEGORIES: readonly Readonly<{ id: string; title: string; order: number }>[];
export const SITE_INTERVIEW_QUESTIONS: readonly SiteInterviewQuestionData[];
export function validateSiteInterviewCatalog(questions?: readonly SiteInterviewQuestionData[]): Readonly<{
  ok: boolean;
  errors: readonly string[];
  count: number;
}>;
