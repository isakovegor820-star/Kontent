import { validatePostQuality } from "./post-quality.mjs";
import { validateSemanticClaims } from "./semantic-claims.mjs";

const SAFE_LENGTH_QUESTIONS = [
  "Что из этого для тебя важнее?",
  "Какой из этих пунктов ты бы проверил первым?",
  "Какой из этих пунктов сейчас важнее для твоей ситуации и что стоит разобрать подробнее в следующем посте?",
];

/**
 * Classify a failed gate before spending another model call. Missing evidence and an
 * unavailable semantic checker cannot be repaired by rewriting the same text. They need
 * human review (and remain ineligible for automatic publication).
 */
export function autopilotQualityFailureKind(result) {
  if (result?.passed === true) return "passed";
  const codes = new Set(
    (Array.isArray(result?.violations) ? result.violations : [])
      .map((violation) => String(violation?.code || "")),
  );
  if (codes.has("no_sources")) return "missing_evidence";
  if (result?.semantic?.status === "not_checked" || codes.has("semantic_review_required")) {
    return "semantic_unavailable";
  }
  return "rewriteable";
}

/** Fill only a small length miss with a non-factual question, never with invented facts. */
export function padDraftToMinimum(text, minChars, maxChars) {
  const value = String(text || "").trim();
  const minimum = Math.max(0, Number(minChars) || 0);
  const maximum = Math.max(minimum, Number(maxChars) || minimum);
  if (!value || value.length >= minimum || minimum - value.length > 140) return value;
  for (const question of SAFE_LENGTH_QUESTIONS) {
    const candidate = `${value}\n\n${question}`;
    if (candidate.length >= minimum && candidate.length <= maximum) return candidate;
  }
  return value;
}

/**
 * Final fail-safe after model rewrites: delete only the exact sentences the semantic
 * validator rejected. This cannot introduce a new claim and is therefore safer and faster
 * than asking the model for another open-ended rewrite.
 */
export function removeUnverifiedSemanticClaims(text, semantic) {
  const verdicts = semantic?.claimVerdicts || [];
  const hasVerifiedClaim = verdicts.some(
    (verdict) => verdict?.verdict === "supported" || verdict?.verdict === "non_factual",
  );
  const unsupported = verdicts
    .filter((verdict) =>
      verdict?.verdict === "unsupported" ||
      (hasVerifiedClaim && verdict?.verdict === "unknown"),
    )
    .map((verdict) => String(verdict.claim || "").trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  if (!unsupported.length) return String(text || "").trim();

  let cleaned = String(text || "");
  for (const claim of unsupported) {
    let index = cleaned.indexOf(claim);
    while (index >= 0) {
      cleaned = cleaned.slice(0, index) + cleaned.slice(index + claim.length);
      index = cleaned.indexOf(claim);
    }
  }
  return cleaned
    .split("\n")
    .map((line) => line.replace(/^\s*[-–—*•]\s*$/u, "").trimEnd())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** Production Autopilot quality builder used before both manual bulk and full auto mode. */
export async function assessAutopilotDraft({
  text,
  quality,
  topic,
  sources,
  citedShare = null,
  invented = [],
  trigger = "generation",
  semanticAdapter = null,
  signal,
  now,
}) {
  const deterministic = validatePostQuality(text, quality, {
    topic,
    supportCount: Array.isArray(sources) ? sources.length : 0,
    citedShare,
    invented,
    trigger,
    checkedAt: now ? now() : undefined,
  });
  const semantic = await validateSemanticClaims(
    { text, sources: Array.isArray(sources) ? sources : [] },
    { adapter: semanticAdapter, signal, now },
  );
  const semanticMessages = semantic.status === "blocked"
    ? semantic.blockers.map((blocker) => blocker.message)
    : semantic.status === "not_checked"
      ? ["Смысл фактических утверждений не проверен. Нужна ручная проверка перед публикацией."]
      : [];
  const semanticViolations = semantic.status === "blocked"
    ? semantic.blockers.map((blocker) => ({
        code: blocker.code,
        message: blocker.message,
        blocker: true,
        penalty: 50,
      }))
    : semantic.status === "not_checked"
      ? [{
          code: "semantic_review_required",
          message: semanticMessages[0],
          blocker: true,
          penalty: 0,
        }]
      : [];
  // Inline [1] markers are an early, deliberately rough grounding signal. Once the
  // claim-level semantic validator has proved every factual sentence against concrete
  // source spans, a low marker ratio must not keep an otherwise verified draft blocked.
  // `no_sources` and every other deterministic blocker remain untouched.
  const deterministicViolations = semantic.status === "passed"
    ? deterministic.violations.filter((violation) => violation.code !== "weak_sources")
    : deterministic.violations;
  const deterministicScore = Math.max(
    0,
    100 - deterministicViolations.reduce((sum, violation) => sum + violation.penalty, 0),
  );
  const deterministicBlockers = deterministicViolations
    .filter((violation) => violation.blocker)
    .map((violation) => violation.message);
  const deterministicPassed = deterministicBlockers.length === 0 &&
    deterministicScore >= deterministic.threshold;
  const passed = deterministicPassed && semantic.status === "passed";
  return {
    ...deterministic,
    score: semantic.status === "passed"
      ? deterministicScore
      : Math.min(deterministicScore, Math.max(0, deterministic.threshold - 1)),
    passed,
    blockers: [...deterministicBlockers, ...semanticMessages],
    violations: [...deterministicViolations, ...semanticViolations],
    semantic,
  };
}
