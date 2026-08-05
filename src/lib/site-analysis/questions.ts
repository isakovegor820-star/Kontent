import {
  SITE_INTERVIEW_CATALOG_VERSION,
  SITE_INTERVIEW_CATEGORIES,
  SITE_INTERVIEW_QUESTIONS,
  validateSiteInterviewCatalog,
  type SiteInterviewAnswerType,
  type SiteInterviewMinimumConfidence,
} from "./questions.data.mjs";

export type SiteInterviewQuestion = {
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
};
export {
  SITE_INTERVIEW_CATALOG_VERSION,
  SITE_INTERVIEW_CATEGORIES,
  SITE_INTERVIEW_QUESTIONS,
  validateSiteInterviewCatalog,
};
