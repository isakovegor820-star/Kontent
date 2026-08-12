export const TYPOGRAPHY_RULES_VERSION = "aurora-ru-typographer-v2" as const;

export const BRAND_DICTIONARY_ENTRY_KINDS = [
  "canonical",
  "allowed",
  "prohibited",
  "exception",
  "abbreviation",
] as const;

export type BrandDictionaryEntryKind = (typeof BRAND_DICTIONARY_ENTRY_KINDS)[number];

/**
 * The optional legacy fields keep the deterministic engine compatible with older
 * callers while the persisted project dictionary uses `kind` + `replacement`.
 */
export type BrandDictionaryEntry = {
  id?: number;
  kind?: BrandDictionaryEntryKind;
  term: string;
  replacement?: string | null;
  expansion?: string | null;
  caseSensitive?: boolean;
  version?: number;
  active?: boolean;
  canonical?: string;
  prohibited?: boolean;
};

export type TypographySuggestionKind =
  | "brand_term"
  | "dash"
  | "hyphen"
  | "quotes"
  | "range"
  | "spacing"
  | "typo"
  | "unbreakable";

export type ProtectedFragmentKind =
  | "url"
  | "email"
  | "utm"
  | "code"
  | "case_number"
  | "article"
  | "date"
  | "exact_quote"
  | "domain"
  | "dictionary_exception";

export type TypographySuggestion = {
  id: string;
  kind: TypographySuggestionKind;
  start: number;
  end: number;
  before: string;
  after: string;
  safe: boolean;
  explanation: string;
  rule: string;
  dictionaryEntryId?: number;
  dictionaryKind?: BrandDictionaryEntryKind;
};

export type LegalTypographyOptions = {
  dictionary?: readonly BrandDictionaryEntry[];
  /** Exact quotations are protected by default. Straight quotes become an explicit, unsafe suggestion only when enabled. */
  formatQuotes?: boolean;
  /** Server-only escape hatch for an explicitly authorised protected-fragment edit. The product UI does not enable it. */
  allowProtectedChanges?: readonly ProtectedFragmentKind[];
};

type TextRange = { start: number; end: number; kind: ProtectedFragmentKind };

type NormalizedDictionaryEntry = {
  id?: number;
  kind: BrandDictionaryEntryKind;
  term: string;
  replacement: string | null;
  expansion: string | null;
  caseSensitive: boolean;
};

const PROTECTED_PATTERNS: readonly { kind: ProtectedFragmentKind; pattern: RegExp }[] = [
  { kind: "code", pattern: /```[\s\S]*?```|`[^`\r\n]*`/gu },
  { kind: "url", pattern: /https?:\/\/[^\s<>()\[\]{}"']+/giu },
  { kind: "url", pattern: /\bwww\.[^\s<>()\[\]{}"']+/giu },
  { kind: "email", pattern: /(?<![\p{L}\d._%+-])[\p{L}\d._%+-]+@[\p{L}\d.-]+\.[\p{L}]{2,}(?![\p{L}\d.-])/giu },
  { kind: "utm", pattern: /\butm_(?:source|medium|campaign|content|term)=[^\s&#]+/giu },
  {
    kind: "domain",
    pattern: /(?<![@\p{L}\d-])(?:[\p{L}\d](?:[\p{L}\d-]{0,61}[\p{L}\d])?\.)+(?:ru|рф|com|org|net|io|dev|ai)(?:\/[^\s<>()\[\]{}"']*)?/giu,
  },
  {
    kind: "case_number",
    pattern: /\b(?:дел[оауе]\s+)?№\s*[\p{L}\d][\p{L}\d-]*(?:\/[\p{L}\d-]+)*(?=$|[\s,.;:!?()])/giu,
  },
  { kind: "case_number", pattern: /(?<![\p{L}\d])[АA]\d{1,3}-\d{2,}(?:\/\d{2,4})?(?![\p{L}\d])/gu },
  {
    kind: "article",
    pattern: /(?<![\p{L}\d])(?:(?:(?:п|пп|ч)\.\s*\d+(?:\.\d+)*\s+)*)(?:ст|статья)\.?\s*\d+(?:\.\d+)*(?:[-–]\d+)?(?![\p{L}\d])/giu,
  },
  { kind: "date", pattern: /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/gu },
  { kind: "date", pattern: /(?<!\d)\d{1,2}[./-]\d{1,2}[./-]\d{2,4}(?!\d)/gu },
  { kind: "exact_quote", pattern: /“[^”\r\n]*”/gu },
];

const SAFE_TYPOS: readonly { from: string; to: string }[] = [
  { from: "вообщем", to: "в общем" },
  { from: "вобщем", to: "в общем" },
  { from: "учавствовать", to: "участвовать" },
  { from: "будующий", to: "будущий" },
  { from: "прийдется", to: "придётся" },
  { from: "прийдётся", to: "придётся" },
  { from: "агенство", to: "агентство" },
  { from: "юристконсульт", to: "юрисконсульт" },
];

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizedDictionary(entries: readonly BrandDictionaryEntry[]): NormalizedDictionaryEntry[] {
  return entries
    .filter((entry) => entry.active !== false)
    .map((entry) => {
      const kind = entry.kind
        ?? (entry.prohibited === true ? "prohibited" : "canonical");
      return {
        id: Number.isSafeInteger(entry.id) && Number(entry.id) > 0 ? Number(entry.id) : undefined,
        kind,
        term: String(entry.term ?? "").normalize("NFC").trim(),
        replacement: String(entry.replacement ?? entry.canonical ?? "").normalize("NFC").trim() || null,
        expansion: String(entry.expansion ?? "").normalize("NFC").trim() || null,
        caseSensitive: entry.caseSensitive === true,
      };
    })
    .filter((entry) => entry.term.length > 0)
    .sort((left, right) => (
      right.term.length - left.term.length
      || left.kind.localeCompare(right.kind)
      || left.term.localeCompare(right.term, "ru")
      || (left.id ?? 0) - (right.id ?? 0)
    ));
}

function dictionaryPattern(entry: Pick<NormalizedDictionaryEntry, "term" | "caseSensitive">) {
  return new RegExp(
    `(?<![\\p{L}\\d])${escapeRegExp(entry.term)}(?![\\p{L}\\d])`,
    entry.caseSensitive ? "gu" : "giu",
  );
}

function balancedGuillemetRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  let depth = 0;
  let start = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "«") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "»" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        ranges.push({ start, end: index + 1, kind: "exact_quote" });
        start = -1;
      }
    }
  }
  return ranges;
}

function straightQuoteGroups(text: string): { start: number; end: number; after: string }[] {
  const groups: { start: number; end: number; after: string }[] = [];
  const stack: number[] = [];
  const records: { index: number; opening: boolean; depth: number }[] = [];
  let groupRecordStart = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '"' || (index > 0 && text[index - 1] === "\\")) continue;
    const previous = index === 0 ? "" : text[index - 1];
    const next = index + 1 >= text.length ? "" : text[index + 1];
    const openingSignal = index === 0 || /[\s([{—–:;!?]/u.test(previous);
    const closingSignal = index + 1 === text.length || /[\s)\]}.!,;:!?»"]/u.test(next);
    const opening = stack.length === 0 || (openingSignal && !closingSignal);

    if (opening) {
      records.push({ index, opening: true, depth: stack.length });
      stack.push(index);
      continue;
    }
    if (stack.length === 0) continue;
    stack.pop();
    records.push({ index, opening: false, depth: stack.length });
    if (stack.length !== 0) continue;

    const groupRecords = records.slice(groupRecordStart);
    groupRecordStart = records.length;
    const start = groupRecords[0]?.index ?? index;
    const replacements = new Map<number, string>();
    for (const record of groupRecords) {
      if (record.opening) replacements.set(record.index, record.depth === 0 ? "«" : record.depth % 2 === 1 ? "„" : "‘");
      else replacements.set(record.index, record.depth === 0 ? "»" : record.depth % 2 === 1 ? "“" : "’");
    }
    let after = "";
    for (let cursor = start; cursor <= index; cursor += 1) {
      after += replacements.get(cursor) ?? text[cursor];
    }
    groups.push({ start, end: index + 1, after });
  }
  return groups;
}

function patternRanges(text: string, pattern: RegExp, kind: ProtectedFragmentKind): TextRange[] {
  pattern.lastIndex = 0;
  const ranges: TextRange[] = [];
  for (const match of text.matchAll(pattern)) {
    if (match.index == null || match[0].length === 0) continue;
    ranges.push({ start: match.index, end: match.index + match[0].length, kind });
  }
  return ranges;
}

function protectedRanges(
  text: string,
  options: LegalTypographyOptions,
  dictionary: readonly NormalizedDictionaryEntry[],
): TextRange[] {
  const allowed = new Set(options.allowProtectedChanges ?? []);
  const ranges: TextRange[] = [];
  for (const { kind, pattern } of PROTECTED_PATTERNS) {
    if (!allowed.has(kind)) ranges.push(...patternRanges(text, pattern, kind));
  }
  if (!allowed.has("exact_quote")) {
    ranges.push(...balancedGuillemetRanges(text));
    if (options.formatQuotes !== true) {
      for (const group of straightQuoteGroups(text)) {
        ranges.push({ start: group.start, end: group.end, kind: "exact_quote" });
      }
    }
  }
  if (!allowed.has("dictionary_exception")) {
    for (const entry of dictionary) {
      if (entry.kind !== "exception") continue;
      ranges.push(...patternRanges(text, dictionaryPattern(entry), "dictionary_exception"));
    }
  }
  return ranges.sort((left, right) => left.start - right.start || left.end - right.end || left.kind.localeCompare(right.kind));
}

function intersects(ranges: readonly TextRange[], start: number, end: number) {
  return ranges.some((range) => start < range.end && end > range.start);
}

function suggestionId(
  kind: TypographySuggestionKind,
  rule: string,
  start: number,
  before: string,
  after: string,
) {
  let hash = 2166136261;
  const input = `${kind}\u0000${rule}\u0000${start}\u0000${before}\u0000${after}`;
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
  input: {
    kind: TypographySuggestionKind;
    rule: string;
    replacement: (match: RegExpMatchArray) => string;
    safe: boolean;
    explanation: string | ((match: RegExpMatchArray) => string);
    dictionaryEntryId?: number;
    dictionaryKind?: BrandDictionaryEntryKind;
  },
) {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index == null || match[0].length === 0) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (intersects(ranges, start, end)) continue;
    const after = input.replacement(match);
    if (after === match[0]) continue;
    target.push({
      id: suggestionId(input.kind, input.rule, start, match[0], after),
      kind: input.kind,
      start,
      end,
      before: match[0],
      after,
      safe: input.safe,
      explanation: typeof input.explanation === "function" ? input.explanation(match) : input.explanation,
      rule: input.rule,
      ...(input.dictionaryEntryId == null ? {} : { dictionaryEntryId: input.dictionaryEntryId }),
      ...(input.dictionaryKind == null ? {} : { dictionaryKind: input.dictionaryKind }),
    });
  }
}

function preserveCase(source: string, replacement: string) {
  if (source === source.toLocaleUpperCase("ru-RU")) return replacement.toLocaleUpperCase("ru-RU");
  const first = source[0];
  if (first && first === first.toLocaleUpperCase("ru-RU")) {
    return replacement[0]?.toLocaleUpperCase("ru-RU") + replacement.slice(1);
  }
  return replacement;
}

/**
 * Produces deterministic, non-destructive suggestions for Russian legal copy.
 * URLs, e-mail, UTM values, code, case numbers, article references, dates and
 * exact quotations are excluded before any rule is evaluated.
 */
export function analyzeLegalTypography(
  text: string,
  options: LegalTypographyOptions = {},
): TypographySuggestion[] {
  const dictionary = normalizedDictionary(options.dictionary ?? []);
  const ranges = protectedRanges(text, options, dictionary);
  const suggestions: TypographySuggestion[] = [];

  addMatches(suggestions, text, ranges, /[ \t]{2,}/gu, {
    kind: "spacing",
    rule: "spaces.duplicate",
    replacement: () => " ",
    safe: true,
    explanation: "Убрать лишний пробел",
  });
  addMatches(suggestions, text, ranges, /[ \t]+([,.;:!?])/gu, {
    kind: "spacing",
    rule: "spaces.before-punctuation",
    replacement: (match) => String(match[1]),
    safe: true,
    explanation: "Убрать пробел перед знаком препинания",
  });
  addMatches(suggestions, text, ranges, /([,;:!?])(?=[\p{L}])/gu, {
    kind: "spacing",
    rule: "spaces.after-punctuation",
    replacement: (match) => `${match[1]} `,
    safe: true,
    explanation: "Добавить пробел после знака препинания",
  });
  addMatches(suggestions, text, ranges, /[ \t]+(?:--?|—|–)[ \t]+/gu, {
    kind: "dash",
    rule: "dash.sentence",
    replacement: () => " — ",
    safe: true,
    explanation: "Поставить длинное тире",
  });
  addMatches(suggestions, text, ranges, /(?<!\d)(\d{1,4})[ \t]*-[ \t]*(\d{1,4})(?!\d)/gu, {
    kind: "range",
    rule: "range.numeric",
    replacement: (match) => `${match[1]}–${match[2]}`,
    safe: true,
    explanation: "Оформить числовой диапазон",
  });
  addMatches(
    suggestions,
    text,
    ranges,
    /(?<![\p{L}])(кто|что|где|когда|как|какой|чей|почему|зачем|сколько)[ \t]+-[ \t]+(то|либо|нибудь)(?![\p{L}])/giu,
    {
      kind: "hyphen",
      rule: "hyphen.indefinite-pronoun",
      replacement: (match) => `${match[1]}-${match[2]}`,
      safe: true,
      explanation: "Соединить части слова дефисом",
    },
  );
  addMatches(
    suggestions,
    text,
    ranges,
    /(?<![\p{L}])(во|в)[ \t]+-[ \t]+(первых|вторых|третьих)(?![\p{L}])/giu,
    {
      kind: "hyphen",
      rule: "hyphen.enumeration",
      replacement: (match) => `${match[1]}-${match[2]}`,
      safe: true,
      explanation: "Соединить части вводного слова дефисом",
    },
  );
  addMatches(
    suggestions,
    text,
    ranges,
    /(?<![\p{L}\d])(а|в|и|к|о|с|у|я|на|не|но|по|за|из|от|до|во|со)[ \t]+(?=[\p{L}\d])/giu,
    {
      kind: "unbreakable",
      rule: "nbsp.short-word",
      replacement: (match) => `${match[1]}\u00a0`,
      safe: true,
      explanation: "Не отрывать короткое слово от следующего",
    },
  );
  addMatches(
    suggestions,
    text,
    ranges,
    /(\d)[ \t]+(?=(?:%|₽|руб\.?|тыс\.?|млн|млрд|кг|см|мм)\b)/giu,
    {
      kind: "unbreakable",
      rule: "nbsp.number-unit",
      replacement: (match) => `${match[1]}\u00a0`,
      safe: true,
      explanation: "Не отрывать число от единицы измерения",
    },
  );
  addMatches(suggestions, text, ranges, /(\p{Lu}\.)[ \t]+(?=\p{Lu}\.)/gu, {
    kind: "unbreakable",
    rule: "nbsp.initials",
    replacement: (match) => `${match[1]}\u00a0`,
    safe: true,
    explanation: "Не разрывать инициалы переносом строки",
  });
  addMatches(suggestions, text, ranges, /(\p{Lu}\.)[ \t]+(?=\p{Lu}[\p{Ll}])/gu, {
    kind: "unbreakable",
    rule: "nbsp.initial-surname",
    replacement: (match) => `${match[1]}\u00a0`,
    safe: true,
    explanation: "Не отрывать инициалы от фамилии",
  });

  for (const typo of SAFE_TYPOS) {
    addMatches(
      suggestions,
      text,
      ranges,
      new RegExp(`(?<![\\p{L}])${escapeRegExp(typo.from)}(?![\\p{L}])`, "giu"),
      {
        kind: "typo",
        rule: `typo.${typo.from}`,
        replacement: (match) => preserveCase(match[0], typo.to),
        safe: true,
        explanation: "Исправить однозначную опечатку",
      },
    );
  }

  if (options.formatQuotes === true) {
    for (const group of straightQuoteGroups(text)) {
      if (intersects(ranges, group.start, group.end)) continue;
      const before = text.slice(group.start, group.end);
      if (before === group.after) continue;
      suggestions.push({
        id: suggestionId("quotes", "quotes.russian-nested", group.start, before, group.after),
        kind: "quotes",
        start: group.start,
        end: group.end,
        before,
        after: group.after,
        safe: false,
        explanation: "Оформить русские вложенные кавычки — проверь точность цитаты",
        rule: "quotes.russian-nested",
      });
    }
  }

  const allowedDictionaryRanges = dictionary
    .filter((entry) => entry.kind === "allowed")
    .flatMap((entry) => patternRanges(text, dictionaryPattern(entry), "dictionary_exception"));

  for (const entry of dictionary) {
    if (entry.kind === "allowed" || entry.kind === "exception" || !entry.replacement) continue;
    const safe = entry.kind === "canonical";
    addMatches(suggestions, text, [...ranges, ...allowedDictionaryRanges], dictionaryPattern(entry), {
      kind: "brand_term",
      rule: `dictionary.${entry.kind}.${entry.id ?? entry.term}`,
      replacement: () => entry.replacement as string,
      safe,
      dictionaryEntryId: entry.id,
      dictionaryKind: entry.kind,
      explanation: entry.kind === "prohibited"
        ? `Заменить запрещённый вариант на «${entry.replacement}»`
        : entry.kind === "abbreviation"
          ? `Использовать аббревиатуру «${entry.replacement}»${entry.expansion ? ` (${entry.expansion})` : ""}`
          : `Использовать каноничное написание «${entry.replacement}»`,
    });
  }

  // One fragment may be covered by several rules. Keep the rule with the highest
  // semantic specificity; the next deterministic pass can reveal a later rule.
  const priority: Record<TypographySuggestionKind, number> = {
    brand_term: 8,
    quotes: 7,
    typo: 6,
    hyphen: 5,
    range: 4,
    dash: 3,
    spacing: 2,
    unbreakable: 1,
  };
  const accepted: TypographySuggestion[] = [];
  for (const candidate of suggestions.sort((left, right) => (
    priority[right.kind] - priority[left.kind]
    || left.start - right.start
    || left.end - right.end
    || left.id.localeCompare(right.id)
  ))) {
    if (!accepted.some((item) => candidate.start < item.end && candidate.end > item.start)) {
      accepted.push(candidate);
    }
  }
  return accepted.sort((left, right) => left.start - right.start || left.end - right.end || left.id.localeCompare(right.id));
}

export function applyTypographySuggestions(
  text: string,
  suggestions: readonly TypographySuggestion[],
  accepted: "safe" | readonly string[],
) {
  const acceptedIds = accepted === "safe" ? null : new Set(accepted);
  const selected = suggestions
    .filter((suggestion) => acceptedIds ? acceptedIds.has(suggestion.id) : suggestion.safe)
    .sort((left, right) => right.start - left.start || right.end - left.end || left.id.localeCompare(right.id));

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
  return `${TYPOGRAPHY_RULES_VERSION}:dictionary-${dictionaryVersion ?? "none"}`;
}
