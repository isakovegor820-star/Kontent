import { normalizePostQuality, validatePostQuality } from "./post-quality.mjs";
import { finishPostForm, normalizePostForm, reservedFormChars } from "./post-form.mjs";
import { validateSemanticClaims } from "./semantic-claims.mjs";

// Добивка объёма обязана говорить с читателем так же, как весь канал. Один вариант на
// «ты» стоил месяца сборок: профили «Экспертный» и «Юридический» говорят на «вы», проверка
// ставила блокер «обращение на ты», а редактура его не снимала — короткий текст снова
// добивался тем же вопросом. Обращение канала выбирается здесь, а не достаётся по умолчанию.
const SAFE_LENGTH_QUESTIONS = {
  ты: [
    "Что из этого для тебя важнее?",
    "Какой из этих пунктов ты бы проверил первым?",
    "Какой из этих пунктов сейчас важнее для твоей ситуации и что стоит разобрать подробнее в следующем посте?",
    "Если бы пришлось выбрать один следующий шаг — какой он был бы и почему именно он?",
    "Что здесь для тебя привычно, а что стоит перепроверить на своём материале?",
  ],
  вы: [
    "Что из этого для вас важнее?",
    "Какой из этих пунктов вы бы проверили первым?",
    "Какой из этих пунктов сейчас важнее для вашей ситуации и что стоит разобрать подробнее в следующем посте?",
    "Если бы пришлось выбрать один следующий шаг — какой он был бы и почему именно он?",
    "Что здесь для вас привычно, а что стоит перепроверить на своём материале?",
  ],
  // Канал без прямого обращения: добираем объём наблюдением, а не вопросом читателю.
  neutral: [
    "Этот пункт стоит перечитать отдельно.",
    "Здесь важен порядок действий, а не скорость.",
    "Разбор каждого из этих пунктов заслуживает отдельного поста.",
    "Следующий шаг зависит от того, какой из пунктов ближе к конкретной ситуации.",
    "Часть этого выглядит привычной, а часть стоит перепроверить на своём материале.",
  ],
};

function lengthQuestions(address) {
  return SAFE_LENGTH_QUESTIONS[address] || SAFE_LENGTH_QUESTIONS["вы"];
}

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

/**
 * Drop trailing paragraphs or sentences until the draft fits. Never invent text, never
 * cut mid-sentence, and never return a draft shorter than minChars — a failed trim stays
 * too long so the model can rewrite it instead of handing the user a stub.
 */
export function trimDraftToMaximum(text, maxChars, minChars = 0) {
  const value = String(text || "").trim();
  const maximum = Math.max(0, Number(maxChars) || 0);
  const minimum = Math.max(0, Number(minChars) || 0);
  if (!value || !maximum || value.length <= maximum) return value;

  const paragraphs = value.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  for (let keep = paragraphs.length - 1; keep >= 2; keep -= 1) {
    const candidate = paragraphs.slice(0, keep).join("\n\n");
    if (candidate.length >= minimum && candidate.length <= maximum && /[.!?…»”*)\]]$/u.test(candidate)) {
      return candidate;
    }
  }

  const sentences = value.match(/[^.!?…]+[.!?…]+(?:[»”"')\]]+)?/gu);
  if (sentences?.length) {
    let kept = "";
    for (const sentence of sentences) {
      const next = `${kept}${sentence}`.trim();
      if (next.length > maximum) break;
      kept = next;
    }
    if (kept.length >= minimum && /[.!?…»”*)\]]$/u.test(kept)) return kept;
  }
  return value;
}

/** Fill a length miss with non-factual reader questions, never with invented facts. */
export function padDraftToMinimum(text, minChars, maxChars, address = "вы") {
  let value = String(text || "").trim();
  const minimum = Math.max(0, Number(minChars) || 0);
  const maximum = Math.max(minimum, Number(maxChars) || minimum);
  if (!value || value.length >= minimum) return value;
  for (const question of lengthQuestions(address)) {
    const candidate = `${value}\n\n${question}`;
    if (candidate.length > maximum) continue;
    value = candidate;
    if (value.length >= minimum) return value;
  }
  return value;
}

export function fitAutopilotDraftLength(text, minChars, maxChars, address = "вы") {
  return trimDraftToMaximum(
    padDraftToMinimum(text, minChars, maxChars, address),
    maxChars,
    minChars,
  );
}

/**
 * Единственный путь черновика к проверке: форма приводится к профилю канала, объём
 * подгоняется под оставшееся место, дисклеймер и выделение ставятся последними. Порядок
 * важен — иначе подрезка объёма съедала бы дословный дисклеймер, который сама же и требует.
 */
export function prepareAutopilotDraftForm(text, rawQuality) {
  const q = normalizePostQuality(rawQuality);
  const normalized = normalizePostForm(text, q);
  if (!normalized) return "";
  const reserved = reservedFormChars(normalized, q);
  const fitted = fitAutopilotDraftLength(
    normalized,
    Math.max(0, q.minChars - reserved),
    Math.max(1, q.maxChars - reserved),
    q.address,
  );
  // Добивка объёма склеивает вопрос читателя в отдельный абзац — форму после неё
  // перепроверяем, иначе абзац может выйти за лимит предложений.
  return finishPostForm(normalizePostForm(fitted, q), q);
}

/** Enough completion budget for the channel length band, including a short Russian post. */
export function autopilotOutputTokens(quality) {
  const maxChars = Math.max(500, Number(quality?.maxChars) || 1800);
  return Math.min(1800, Math.max(800, Math.ceil(maxChars * 0.9)));
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
  const reviewClaims = Array.isArray(semantic.reviewClaims) ? semantic.reviewClaims : [];
  const semanticMessages = semantic.status === "blocked"
    ? semantic.blockers.map((blocker) => blocker.message)
    : semantic.status === "not_checked"
      ? reviewClaims.length
        ? reviewClaims.map((claim) => claim.message)
        : ["Автопроверка фактов не отработала. Прочитай текст и нажми «Одобрить» — это и есть проверка."]
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
          blocker: false,
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
  const passed = deterministicPassed && semantic.status !== "blocked";
  return {
    ...deterministic,
    score: semantic.status === "blocked"
      ? Math.min(deterministicScore, Math.max(0, deterministic.threshold - 1))
      : deterministicScore,
    passed,
    blockers: semantic.status === "blocked"
      ? [...deterministicBlockers, ...semanticMessages]
      : deterministicBlockers,
    violations: [...deterministicViolations, ...semanticViolations],
    semantic,
  };
}
