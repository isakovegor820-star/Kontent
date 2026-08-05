const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const INSTRUCTION_IN_SOURCE = /(?:ignore\s+(?:all\s+)?previous|system\s+prompt|developer\s+message|следуй\s+(?:этой|моей)\s+инструкц|игнорируй\s+(?:все\s+)?предыдущ|считай\s+(?:это|текст)\s+(?:истиной|проверенным)|не\s+проверяй\s+факт)/iu;
const HIGH_RISK = [
  ["guarantee", /(?:гарантир\p{L}*|полностью\s+защища\p{L}*|безусловно\s+защища\p{L}*|исключа\p{L}*\s+(?:любой|все)\s+риск)/iu],
  ["universality", /(?:\bвсегда\b|\bникогда\b|\bлюбой\b|\bлюбые\b|\bвсе[мх]?\b|неизменно|в\s+каждом\s+случае)/iu],
  ["causality", /(?:неизменно\s+привод\p{L}*|гарантированно\s+привод\p{L}*|обеспечива\p{L}*\s+результат|позволя\p{L}*\s+избежать)/iu],
  ["legal_obligation", /(?:суд\s+обязан|обязан\p{L}*\s+применить|применя\p{L}*\s+автоматически)/iu],
  ["court_outcome", /(?:суд\s+(?:отказал|удовлетворил|признал|списал)|решени\p{L}*\s+суда\s+(?:будет|неизбежно|предсказуем))/iu],
  ["risk_reduction", /(?:(?:полностью|целиком)\s+снима\p{L}*\s+[^.!?]{0,50}риск|сниж\p{L}*\s+риск|устраня\p{L}*\s+риск)/iu],
];

const clean = (value) => String(value ?? "")
  .normalize("NFKC")
  .toLocaleLowerCase("ru")
  .replace(/ё/gu, "е")
  .replace(/\[(?:\d+|[a-z][\w.-]*)\]/giu, " ")
  .replace(/[«»„“”"'`]/gu, "")
  .replace(/[^\p{L}\p{N}:/.%-]+/gu, " ")
  .replace(/\s+/gu, " ")
  .trim();

const tokens = (value) => [...new Set(clean(value).match(/[\p{L}\p{N}]{3,}/gu) ?? [])]
  .filter((token) => !["который", "которая", "которые", "этого", "также", "может", "более"].includes(token));

function overlap(left, right) {
  const leftTokens = tokens(left);
  if (!leftTokens.length) return 0;
  const rightSet = new Set(tokens(right));
  return leftTokens.filter((token) => rightSet.has(token)).length / leftTokens.length;
}

function negated(value) {
  return /(?:^|\s)(?:не|ни|нельзя|отсутств\p{L}*|исключени\p{L}*)(?:\s|$)/iu.test(clean(value));
}

export function extractSemanticClaims(text) {
  return String(text ?? "")
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((sentence) => sentence.replace(/^[-–—*•\d.)\s]+/u, "").trim())
    .filter((sentence) => sentence.length >= 12 && !sentence.endsWith("?"))
    .slice(0, 80)
    .map((sentence, index) => ({ id: `claim-${index + 1}`, text: sentence.slice(0, 1_000) }));
}

function evidenceSpans(sources) {
  const accepted = [];
  const rejected = [];
  for (const source of Array.isArray(sources) ? sources.slice(0, 100) : []) {
    const id = String(source?.id ?? "").trim().slice(0, 200);
    const text = String(source?.text ?? "").slice(0, 8_000);
    if (!id || !text.trim()) continue;
    let cursor = 0;
    for (const fragment of text.split(/(?<=[.!?…;])\s+|\n+/u)) {
      const start = text.indexOf(fragment, cursor);
      const end = start + fragment.length;
      cursor = Math.max(end, cursor);
      const span = { sourceId: id, start: Math.max(0, start), end: Math.max(0, end), text: fragment.trim() };
      if (!span.text) continue;
      if (INSTRUCTION_IN_SOURCE.test(span.text)) rejected.push(span);
      else accepted.push(span);
    }
  }
  return { accepted, rejected };
}

function supportingSpan(claim, spans) {
  const normalizedClaim = clean(claim);
  const ranked = spans
    .map((span) => ({ span, score: overlap(claim, span.text) }))
    .sort((a, b) => b.score - a.score);
  const exact = ranked.find(({ span }) => clean(span.text).includes(normalizedClaim));
  return exact?.span ?? ranked[0]?.span ?? null;
}

function riskCodes(claim) {
  return HIGH_RISK.filter(([, pattern]) => pattern.test(claim)).map(([code]) => code);
}

function directEntailment(claim, span) {
  if (!span) return false;
  const normalizedClaim = clean(claim);
  const normalizedSource = clean(span.text);
  if (normalizedSource.includes(normalizedClaim)) return true;
  return overlap(claim, span.text) >= 0.88 && negated(claim) === negated(span.text);
}

function publicSpan(span) {
  return span ? { sourceId: span.sourceId, start: span.start, end: span.end } : null;
}

/**
 * Semantic publication boundary. Obvious high-risk expansions are rejected locally;
 * every other declarative claim still needs a complete adapter verdict. Citations are
 * deliberately removed before matching and source instructions are not evidence.
 */
export async function validateSemanticClaims(
  { text, sources },
  { adapter = null, signal, now = () => new Date() } = {},
) {
  const claims = extractSemanticClaims(text);
  const spans = evidenceSpans(sources);
  const preliminary = claims.map((claim) => {
    const span = supportingSpan(claim.text, spans.accepted);
    const risks = riskCodes(claim.text);
    const direct = directEntailment(claim.text, span);
    const contradicted = Boolean(span && overlap(claim.text, span.text) >= 0.65 && negated(claim.text) !== negated(span.text));
    return { claim, span, risks, direct, contradicted };
  });

  const localUnsupported = new Set(
    preliminary
      .filter((entry) => entry.contradicted || (entry.risks.length > 0 && !entry.direct))
      .map((entry) => entry.claim.id),
  );
  let adapterVerdicts = new Map();
  let adapterId = "unavailable";
  let adapterModel = null;
  let adapterFailed = false;
  if (adapter) {
    adapterId = SAFE_ID.test(String(adapter.id || "").toLowerCase())
      ? String(adapter.id).toLowerCase()
      : "invalid-adapter";
    adapterModel = SAFE_ID.test(String(adapter.model || "").toLowerCase())
      ? String(adapter.model).toLowerCase()
      : null;
    try {
      const response = await adapter.check(
        {
          claims,
          evidence: spans.accepted.map((span) => ({
            id: span.sourceId,
            text: span.text,
            start: span.start,
            end: span.end,
          })),
        },
        { signal },
      );
      if (!response || !Array.isArray(response.verdicts)) adapterFailed = true;
      else {
        for (const verdict of response.verdicts) {
          if (!claims.some((claim) => claim.id === verdict?.claimId)) continue;
          if (!["supported", "unsupported", "unknown", "non_factual"].includes(verdict?.verdict)) continue;
          adapterVerdicts.set(verdict.claimId, verdict);
        }
      }
    } catch {
      adapterFailed = true;
    }
  }

  const verdicts = preliminary.map((entry) => {
    const adapterVerdict = adapterVerdicts.get(entry.claim.id);
    let verdict = "unknown";
    let reasonCode = adapter ? "semantic_verdict_missing" : "semantic_provider_unavailable";
    if (localUnsupported.has(entry.claim.id)) {
      verdict = "unsupported";
      reasonCode = entry.contradicted ? "source_contradiction" : `unsupported_${entry.risks[0]}`;
    } else if (adapterVerdict?.verdict === "unsupported") {
      verdict = "unsupported";
      reasonCode = String(adapterVerdict.reasonCode || "adapter_unsupported").slice(0, 80);
    } else if (adapterVerdict?.verdict === "supported") {
      const ids = Array.isArray(adapterVerdict.evidenceIds) ? adapterVerdict.evidenceIds.map(String) : [];
      const cited = spans.accepted.filter((span) => ids.includes(span.sourceId));
      const citedSpan = supportingSpan(entry.claim.text, cited);
      if (citedSpan) {
        verdict = "supported";
        reasonCode = "entailed_by_source";
        entry.span = citedSpan;
      } else {
        reasonCode = "supported_without_source_span";
      }
    } else if (adapterVerdict?.verdict === "unknown") {
      reasonCode = "adapter_unknown";
    } else if (adapterVerdict?.verdict === "non_factual") {
      verdict = "non_factual";
      reasonCode = String(adapterVerdict.reasonCode || "non_factual_expression").slice(0, 80);
    } else if (adapterFailed) {
      reasonCode = "semantic_provider_failed";
    }
    return {
      claimId: entry.claim.id,
      claim: entry.claim.text,
      verdict,
      reasonCode,
      riskCodes: entry.risks,
      sourceSpans: verdict === "supported" && entry.span ? [publicSpan(entry.span)] : [],
    };
  });

  const unsupported = verdicts.filter((verdict) => verdict.verdict === "unsupported");
  const unknown = verdicts.filter((verdict) => verdict.verdict === "unknown");
  const status = unsupported.length > 0
    ? "blocked"
    : claims.length > 0 && unknown.length === 0
      ? "passed"
      : "not_checked";
  return {
    version: 1,
    status,
    passed: status === "passed",
    requiresReview: status === "not_checked",
    blockers: unsupported.map((verdict) => ({
      code: "unsupported_semantic_claim",
      claimId: verdict.claimId,
      message: `Утверждение не подтверждено источниками: ${verdict.claim.slice(0, 180)}`,
    })),
    claimVerdicts: verdicts,
    provenance: {
      validatorVersion: "semantic-publication-v1",
      checkedAt: now().toISOString(),
      provider: adapterId,
      model: adapterModel,
      sourceIds: [...new Set(spans.accepted.map((span) => span.sourceId))],
      rejectedSourceSpans: spans.rejected.map(publicSpan),
      terminalVerdict: status,
    },
  };
}
