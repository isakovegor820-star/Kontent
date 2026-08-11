export type BrandDictionaryEntry = {
  term: string;
  canonical: string;
  prohibited?: boolean;
  caseSensitive?: boolean;
  expansion?: string | null;
};

export type TypographySuggestionKind =
  | "brand_term"
  | "dash"
  | "quotes"
  | "range"
  | "spacing"
  | "unbreakable";

export type TypographySuggestion = {
  id: string;
  kind: TypographySuggestionKind;
  start: number;
  end: number;
  before: string;
  after: string;
  safe: boolean;
  explanation: string;
};

export type LegalTypographyOptions = {
  dictionary?: readonly BrandDictionaryEntry[];
  /** Quotes may contain exact legal wording, so changing them is opt-in. */
  formatQuotes?: boolean;
};

type TextRange = { start: number; end: number };

const PROTECTED_PATTERNS: readonly RegExp[] = [
  /`[^`]*`/gu,
  /https?:\/\/[^\s<>()]+/giu,
  /\bwww\.[^\s<>()]+/giu,
  /\b[\p{L}\d._%+-]+@[\p{L}\d.-]+\.[\p{L}]{2,}\b/giu,
  /\b[\p{L}\d-]+\.(?:ru|рф|com|org|net|io|рф)(?:\/[^\s<>()]*)?/giu,
  /(?:\bдел[оауе]\s*)?№\s*[\p{L}\d-]+(?:\/[\p{L}\d-]+)+/giu,
  /\b(?:ч\.\s*\d+(?:\.\d+)*\s*)?ст\.\s*\d+(?:\.\d+)*\b/giu,
  /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/gu,
  /«[^»]*»/gu,
];

function protectedRanges(text: string, formatQuotes: boolean): TextRange[] {
  const ranges: TextRange[] = [];
  for (const pattern of PROTECTED_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index == null) continue;
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  if (!formatQuotes) {
    for (const match of text.matchAll(/"[^"\n]+"/gu)) {
      if (match.index == null) continue;
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return ranges.sort((left, right) => left.start - right.start || left.end - right.end);
}

function intersects(ranges: readonly TextRange[], start: number, end: number) {
  return ranges.some((range) => start < range.end && end > range.start);
}

function suggestionId(kind: TypographySuggestionKind, start: number, before: string, after: string) {
  let hash = 2166136261;
  const input = `${kind}\u0000${start}\u0000${before}\u0000${after}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `typ-${(hash >>> 0).toString(36)}`;
}

function addMatches(
  target: TypographySuggestion[],
  text: string,
  ranges: readonly TextRange[],
  pattern: RegExp,
  kind: TypographySuggestionKind,
  replacement: (match: RegExpMatchArray) => string,
  safe: boolean,
  explanation: string,
) {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index == null) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (intersects(ranges, start, end)) continue;
    const after = replacement(match);
    if (after === match[0]) continue;
    target.push({
      id: suggestionId(kind, start, match[0], after),
      kind,
      start,
      end,
      before: match[0],
      after,
      safe,
      explanation,
    });
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Produces deterministic, non-destructive suggestions for Russian legal copy.
 * URLs, e-mail, code, case numbers, article references, dates and existing exact
 * quotations are excluded before any rule is evaluated.
 */
export function analyzeLegalTypography(
  text: string,
  options: LegalTypographyOptions = {},
): TypographySuggestion[] {
  const ranges = protectedRanges(text, options.formatQuotes === true);
  const suggestions: TypographySuggestion[] = [];

  addMatches(
    suggestions,
    text,
    ranges,
    /[ \t]{2,}/gu,
    "spacing",
    () => " ",
    true,
    "Убрать лишний пробел",
  );
  addMatches(
    suggestions,
    text,
    ranges,
    /[ \t]+--?[ \t]+/gu,
    "dash",
    () => " — ",
    true,
    "Поставить длинное тире",
  );
  addMatches(
    suggestions,
    text,
    ranges,
    /\b(\d{1,4})-(\d{1,4})\b/gu,
    "range",
    (match) => `${match[1]}–${match[2]}`,
    true,
    "Оформить числовой диапазон",
  );
  addMatches(
    suggestions,
    text,
    ranges,
    /(^|[\s([{])([авиоукс]) /giu,
    "unbreakable",
    (match) => `${match[1]}${match[2]}\u00a0`,
    true,
    "Не отрывать короткий предлог или союз от следующего слова",
  );

  if (options.formatQuotes) {
    addMatches(
      suggestions,
      text,
      ranges,
      /"([^"\n]*)"/gu,
      "quotes",
      (match) => `«${match[1]}»`,
      false,
      "Оформить кавычки — проверьте, что это не точная цитата",
    );
  }

  for (const entry of options.dictionary ?? []) {
    const term = entry.term.trim();
    const canonical = entry.canonical.trim();
    if (!term || !canonical || term === canonical) continue;
    const flags = entry.caseSensitive ? "gu" : "giu";
    const pattern = new RegExp(`(?<![\\p{L}\\d])${escapeRegExp(term)}(?![\\p{L}\\d])`, flags);
    addMatches(
      suggestions,
      text,
      ranges,
      pattern,
      "brand_term",
      () => canonical,
      entry.prohibited !== true,
      entry.prohibited
        ? `Заменить запрещённый вариант на «${canonical}»`
        : `Использовать написание бренда «${canonical}»`,
    );
  }

  // A single character may be covered by more than one rule. Keep the more
  // specific dictionary/quote suggestion and leave the rest for the next pass.
  const priority: Record<TypographySuggestionKind, number> = {
    brand_term: 6,
    quotes: 5,
    dash: 4,
    range: 3,
    spacing: 2,
    unbreakable: 1,
  };
  const accepted: TypographySuggestion[] = [];
  for (const candidate of suggestions.sort((left, right) =>
    priority[right.kind] - priority[left.kind] || left.start - right.start || left.end - right.end
  )) {
    if (!accepted.some((item) => candidate.start < item.end && candidate.end > item.start)) {
      accepted.push(candidate);
    }
  }
  return accepted.sort((left, right) => left.start - right.start || left.end - right.end);
}

export function applyTypographySuggestions(
  text: string,
  suggestions: readonly TypographySuggestion[],
  accepted: "safe" | readonly string[],
) {
  const acceptedIds = accepted === "safe" ? null : new Set(accepted);
  const selected = suggestions
    .filter((suggestion) => acceptedIds ? acceptedIds.has(suggestion.id) : suggestion.safe)
    .sort((left, right) => right.start - left.start || right.end - left.end);

  let result = text;
  let previousStart = Number.POSITIVE_INFINITY;
  for (const suggestion of selected) {
    if (suggestion.end > previousStart) continue;
    if (result.slice(suggestion.start, suggestion.end) !== suggestion.before) continue;
    result = `${result.slice(0, suggestion.start)}${suggestion.after}${result.slice(suggestion.end)}`;
    previousStart = suggestion.start;
  }
  return result;
}

export function typographySnapshotVersion(dictionaryVersion: number | string | null | undefined) {
  return `aurora-ru-typographer-v1:dictionary-${dictionaryVersion ?? "none"}`;
}
