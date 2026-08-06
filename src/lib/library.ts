import type { DraftCreateInput } from "./draft-types";
import { topicFromSourceText } from "./reference-adaptation";

export type LibraryHitAnalysisInput = {
  text: string;
  media?: string | null;
  hitRatio?: number | null;
};

export type LibraryHitAnalysis = {
  hook: string;
  format: string;
  signals: string[];
};

export type LibraryAdaptation = {
  prompt: string;
  referenceText: string;
  referenceSource: string;
};

export type LibraryDraftContextInput = {
  text: string;
  channelId: number;
  clientKey: string;
  reference?: {
    sourcePostId: number | string;
    sourceLabel: string;
  } | null;
  material?: {
    kind: "idea" | "reference";
    id: number | string;
    sourceLabel: string;
    provenanceLabel?: string | null;
    sourceId?: number | string | null;
    sourceUrl?: string | null;
    topic?: string | null;
    hook?: string | null;
    structure?: string | null;
    whyItWorked?: string | null;
  } | null;
};

/**
 * Большой текст уходит в authenticated POST /api/drafts, а переход получает только id.
 * Для чужого примера origin/sourceRef остаются отдельной provenance-меткой и не
 * превращают содержание референса в подтверждённые факты нового поста.
 */
export function buildLibraryDraftContext(input: LibraryDraftContextInput): DraftCreateInput {
  if (!Number.isSafeInteger(input.channelId) || input.channelId <= 0) {
    throw new RangeError("channelId must be a positive safe integer");
  }
  const referenceId = input.reference ? String(input.reference.sourcePostId).trim() : "";
  if (input.reference && !referenceId) {
    throw new RangeError("reference sourcePostId is required");
  }
  const sourceLabel = input.reference?.sourceLabel.trim().slice(0, 400) || "Конкурент";
  const materialId = input.material ? String(input.material.id).trim() : "";
  if (input.material && !materialId) throw new RangeError("material id is required");
  const materialLabel = input.material?.sourceLabel.trim().slice(0, 400) || "Материал библиотеки";
  const provenanceLabel = input.material?.provenanceLabel?.trim().slice(0, 400) || materialLabel;
  const materialSourceRef: DraftCreateInput["sourceRef"] = input.material
    ? {
        kind: input.material.kind,
        id: materialId.slice(0, 200),
        label: materialLabel,
        ...(input.material.topic?.trim() ? { topic: input.material.topic.trim().slice(0, 500) } : {}),
        ...(input.material.hook?.trim() ? { hook: input.material.hook.trim().slice(0, 1_000) } : {}),
        ...(input.material.structure?.trim() ? { structure: input.material.structure.trim().slice(0, 2_000) } : {}),
        ...(input.material.whyItWorked?.trim() ? { whyItWorked: input.material.whyItWorked.trim().slice(0, 1_200) } : {}),
        provenance: {
          kind: input.material.kind === "idea" ? "content_idea" : "competitor_post",
          ...(input.material.sourceId != null ? { id: String(input.material.sourceId).slice(0, 200) } : {}),
          label: provenanceLabel,
          ...(input.material.sourceUrl?.trim() ? { url: input.material.sourceUrl.trim().slice(0, 2_048) } : {}),
        },
      }
    : null;

  return {
    text: input.text,
    media: null,
    scheduledAt: null,
    origin: input.material?.kind === "idea" ? "idea" : input.material || input.reference ? "competitor" : "manual",
    sourceRef: materialSourceRef ?? (input.reference
      ? {
          kind: "competitor",
          id: referenceId.slice(0, 200),
          label: sourceLabel,
          provenance: { kind: "competitor_post", id: referenceId.slice(0, 200), label: sourceLabel },
        }
      : null),
    channelIds: [input.channelId],
    aiValidation: null,
    clientKey: input.clientKey,
  };
}

/**
 * Референс конкурента — образец формы, а не фактический бриф. Держим эти два
 * значения раздельно до самого AI provider, чтобы цифры и реквизиты из чужого
 * поста не становились разрешёнными фактами новой публикации.
 */
export function buildLibraryAdaptation(input: {
  channelName: string;
  text: string;
  source: string;
  topic?: string;
}): LibraryAdaptation {
  const channelName = input.channelName.trim().slice(0, 160) || "выбранного канала";
  const referenceSource = input.source.trim().slice(0, 160) || "из библиотеки";
  // Ограничение относится к AI-контексту, а не к URL: переход передаёт только id
  // серверного черновика, полный исходник остаётся в authenticated storage.
  const referenceText = input.text.trim().slice(0, 1400);
  const topic = input.topic?.trim().slice(0, 320) || topicFromSourceText(referenceText);
  return {
    prompt: [
      `Создай оригинальный пост для канала «${channelName}» строго по теме: «${topic}».`,
      "Сохрани предметную тему и читательскую задачу. Из референса также можно взять хук, структуру, ритм и способ удержания внимания.",
      "Формулировки, цифры, даты, имена, ссылки и выводы референса не переноси. Факты бери только из паспорта и подтверждённых данных моего канала; если их мало, пиши без новой конкретики.",
      "Не заменяй эту тему другой темой из профиля канала, настроек или предыдущего диалога.",
    ].join("\n\n"),
    referenceText,
    referenceSource,
  };
}

/** Внутренние метки помогают искать записи и не обязаны быть хэштегами публикации. */
export function normalizeLibraryLabels(value: unknown, limit = 10): string[] {
  const source = Array.isArray(value) ? value : String(value ?? "").split(/[,;]+/u);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of source) {
    const label = String(item).trim().replace(/^#+/u, "").replace(/\s+/gu, " ").slice(0, 40);
    if (!label) continue;
    const key = label.toLocaleLowerCase("ru");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(label);
    if (result.length >= limit) break;
  }
  return result;
}

/** Хэштеги в библиотеке всегда хранятся в готовом для публикации виде. */
export function normalizeLibraryTags(value: unknown, limit = 30): string[] {
  const source = Array.isArray(value) ? value : String(value ?? "").split(/[\s,]+/u);
  const result: string[] = [];
  const seen = new Set<string>();

  for (const item of source) {
    const clean = String(item)
      .trim()
      .replace(/^#+/u, "")
      .replace(/[^\p{L}\p{N}_-]+/gu, "")
      .slice(0, 48);
    if (!clean) continue;
    const tag = `#${clean}`;
    const key = tag.toLocaleLowerCase("ru");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
    if (result.length >= limit) break;
  }

  return result;
}

/**
 * Быстрый честный разбор референса без выдумывания причин успеха.
 * Показываем только наблюдаемые свойства текста и медиа; коэффициент приходит из аналитики.
 */
export function analyzeLibraryHit({ text, media, hitRatio }: LibraryHitAnalysisInput): LibraryHitAnalysis {
  const normalized = text.trim();
  const paragraphs = normalized.split(/\n\s*\n/u).map((part) => part.trim()).filter(Boolean);
  const firstLine = normalized.split(/\n/u).find((line) => line.trim())?.trim() ?? "Без явного хука";
  const hook = firstLine.length > 150 ? `${firstLine.slice(0, 147)}…` : firstLine;
  const signals: string[] = [];

  if (hitRatio && hitRatio >= 5) signals.push(`Результат ×${hitRatio.toFixed(1)} к норме автора`);
  if (/\?/u.test(firstLine)) signals.push("Начинается с вопроса");
  if (/\d/u.test(firstLine)) signals.push("В хуке есть конкретика");
  if (firstLine.length <= 90) signals.push("Короткий первый экран");
  if (/(?:^|[^\p{L}])(?:я|мы|мой|наш|мне|нас)(?=$|[^\p{L}])/iu.test(normalized.slice(0, 500))) {
    signals.push("Личная подача");
  }
  if (/^\s*(?:[-–—•]|\d+[.)])\s/mu.test(normalized)) signals.push("Есть сканируемый список");
  if (paragraphs.length >= 4) signals.push("Текст разбит на короткие блоки");
  if (!signals.length) signals.push("Результат подтверждён охватом, механику стоит проверить на своей аудитории");

  const mediaValue = media?.toLocaleLowerCase("ru") ?? "";
  const format = mediaValue.includes("video")
    ? "Видео + текст"
    : mediaValue.includes("photo") || mediaValue.includes("image")
      ? "Изображение + текст"
      : normalized.length <= 500
        ? "Короткий текст"
        : "Развёрнутый текст";

  return { hook, format, signals: signals.slice(0, 5) };
}
