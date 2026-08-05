import {
  validateFactualOutput,
  type FactLedger,
  type FactualValidationResult,
  type FactualViolation,
} from "./fact-ledger";
import {
  extractSemanticClaims as extractSharedSemanticClaims,
  validateSemanticClaims,
} from "./semantic-claims.mjs";

export type SemanticClaimVerdict = "supported" | "unsupported" | "unknown";

export interface SemanticClaim {
  id: string;
  text: string;
}

export interface SemanticEvidence {
  id: string;
  text: string;
}

export interface SemanticVerdict {
  claimId: string;
  verdict: SemanticClaimVerdict;
  evidenceIds?: string[];
  /** Stable machine code only. Adapter output is never copied into logs/UI. */
  reasonCode?: string;
}

export interface SemanticEntailmentAdapter {
  /** A non-secret, stable identifier such as `local-nli-v1`. */
  readonly id: string;
  readonly model?: string;
  check(
    input: { claims: SemanticClaim[]; evidence: SemanticEvidence[] },
    options?: { signal?: AbortSignal },
  ): Promise<{ verdicts: SemanticVerdict[] }>;
}

export interface SemanticValidationOptions {
  adapter?: SemanticEntailmentAdapter | null;
  signal?: AbortSignal;
  now?: () => Date;
}

const SAFE_IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

function safeIdentifier(value: unknown, fallback: string): string {
  const candidate = String(value ?? "").trim().toLowerCase();
  return SAFE_IDENTIFIER.test(candidate) ? candidate : fallback;
}

/**
 * Extract declarative units without attempting to decide truth locally. The adapter sees
 * only the generated draft plus the already-authorised ledger evidence. Production does
 * not register an adapter yet, so neither body is sent to an external provider.
 */
export function extractSemanticClaims(text: string): SemanticClaim[] {
  return extractSharedSemanticClaims(text);
}

function notChecked(
  deterministic: FactualValidationResult,
  adapterId: string,
): FactualValidationResult {
  return {
    ...deterministic,
    status: "not_checked",
    passed: false,
    requiresReview: true,
    provenance: {
      ...deterministic.provenance,
      semanticEntailment: "not_checked",
      semanticAdapter: adapterId,
    },
  };
}

/**
 * Deterministic blockers run first. Semantic validation is an explicit adapter boundary:
 * no configured checker, checker failure, malformed/missing verdicts, or `unknown` all
 * fail closed to `not_checked`/human review. Only a complete supported verdict set can
 * become green; any explicit unsupported claim is a hard blocker.
 */
export async function validateFactualOutputWithSemantics(
  text: string,
  ledger: FactLedger,
  options: SemanticValidationOptions = {},
): Promise<FactualValidationResult> {
  const deterministic = validateFactualOutput(text, ledger, { now: options.now });
  if (!deterministic.passed) return deterministic;
  const adapter = options.adapter ?? null;
  const semantic = await validateSemanticClaims(
    {
      text,
      sources: ledger.evidence.map((item) => ({ id: item.id, text: item.text })),
    },
    {
      adapter,
      signal: options.signal,
      now: options.now,
    },
  );
  const adapterId = safeIdentifier(semantic.provenance.provider, "unavailable");
  if (semantic.status === "not_checked") return notChecked(deterministic, adapterId);
  if (semantic.status === "blocked") {
    const unsupported: FactualViolation[] = semantic.blockers.map((blocker) => ({
      code: "unsupported_semantic_claim",
      message: blocker.message,
      blocker: true,
      evidenceId: blocker.claimId,
    }));
    return {
      ...deterministic,
      status: "blocked",
      passed: false,
      requiresReview: false,
      violations: [...deterministic.violations, ...unsupported],
      provenance: {
        ...deterministic.provenance,
        coverage: "deterministic+semantic",
        semanticEntailment: "blocked",
        semanticAdapter: adapterId,
      },
    };
  }

  return {
    ...deterministic,
    status: "passed",
    passed: true,
    requiresReview: false,
    provenance: {
      ...deterministic.provenance,
      coverage: "deterministic+semantic",
      semanticEntailment: "passed",
      semanticAdapter: adapterId,
    },
  };
}
