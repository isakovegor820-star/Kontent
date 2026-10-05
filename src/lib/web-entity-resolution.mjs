// Распознавание сущности в вопросе перед поиском.
//
// Зачем. Замер 05.10.2026 на бесплатных движках показал, что качество выдачи решает
// формулировка запроса, а не движок:
//
//   «6 astra»          → «Sechs – Wikipedia», «LOTTO 6aus49», немецкая лотерея
//   «GPT-6 Astra»      → openai.com, gpt-6-astra, ChatGPT Astra — то, что нужно
//   «astra рынок объём исследование» → спутниковое ТВ и приложение для учёбы
//
// Пользователь спрашивает «расскажи про 6 astra», и по этой строке поисковик честно
// ищет цифру шесть. Wikipedia знает, что за этим стоит: её поиск отдаёт «GPT-6»,
// «GPT-6.1». Каноническое имя сущности и становится поисковым запросом.
//
// Модуль чистый: сеть приходит через `fetchImpl`, поэтому отбор совпадений проверяется
// тестом без сети.

const API_TIMEOUT_MS = 6_000;
const MAX_CANDIDATES = 8;

/** Короткие вопросительные слова и связки: в имени сущности они только мешают. */
const QUESTION_WORDS = new Set([
  "что", "кто", "как", "где", "когда", "почему", "зачем", "это", "такое", "такой",
  "такая", "про", "об", "о", "и", "или", "для", "на", "в", "с", "по", "the", "a", "an",
  "what", "who", "is", "are", "about", "of", "for", "and", "or",
]);

function normalize(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

/**
 * Основы слов темы: те же, что использует план исследования, но без внешних зависимостей —
 * модуль должен оставаться пригодным к проверке отдельно.
 */
function stems(value) {
  return [...new Set(
    normalize(value)
      .toLocaleLowerCase("ru-RU")
      .replace(/ё/gu, "е")
      .split(/[^\p{L}\p{N}-]+/u)
      .filter((word) => word.length >= 3 && !QUESTION_WORDS.has(word)),
  )].slice(0, 8);
}

/**
 * Совпадение кандидата с темой.
 *
 * Заголовок статьи про сущность почти всегда содержит её имя, поэтому проверяются
 * заголовок и начало описания. Общей основы из трёх букв мало: «Astra» есть и у
 * спутникового телевидения, и у приложения для учёбы, и у модели.
 */
function matchesTopic(title, snippet, topic) {
  const topicStems = stems(topic);
  if (!topicStems.length) return 0;
  const haystack = `${title} ${snippet}`.toLocaleLowerCase("ru-RU").replace(/ё/gu, "е");
  return topicStems.filter((stem) => haystack.includes(stem)).length;
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; AuroraResearch/1.0; +https://aurora.local)" },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response?.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Ищет сущность в Wikipedia и возвращает её канонические имена.
 *
 * @returns {Promise<{canonical: string|null, titles: string[], description: string|null, source: string|null}>}
 */
export async function resolveTopicEntity(topic, options = {}) {
  const raw = normalize(topic);
  const empty = { canonical: null, titles: [], description: null, source: null };
  if (raw.length < 3) return empty;
  const fetchImpl = options.fetchImpl || fetch;
  const languages = Array.isArray(options.languages) && options.languages.length
    ? options.languages
    : ["ru", "en"];
  const limit = Math.max(1, Math.min(MAX_CANDIDATES, Number(options.limit) || 5));

  const scored = [];
  for (const language of languages) {
    const url = `https://${language}.wikipedia.org/w/api.php?action=query&list=search`
      + `&srsearch=${encodeURIComponent(raw)}&srlimit=${limit}&format=json&origin=*`;
    const payload = await fetchJson(fetchImpl, url).catch(() => null);
    const hits = Array.isArray(payload?.query?.search) ? payload.query.search : [];
    hits.forEach((hit, index) => {
      const title = normalize(hit?.title);
      if (!title) return;
      // Сниппет приходит с разметкой подсветки совпадений.
      const snippet = normalize(String(hit?.snippet ?? "").replace(/<[^>]+>/gu, " "));
      scored.push({ title, snippet, matched: matchesTopic(title, snippet, raw), order: index });
    });
    // Первого языка с совпадением достаточно: ru и en описывают одну сущность.
    if (scored.some((item) => item.matched > 0)) break;
  }

  const relevant = scored
    .filter((item) => item.matched > 0)
    // Порядок выдачи Wikipedia — это её собственная оценка релевантности, поэтому при
    // равном числе совпавших основ решает он, а не порядок элементов в массиве.
    .sort((left, right) => right.matched - left.matched || left.order - right.order);
  if (!relevant.length) return empty;

  const best = relevant[0];
  // Порядок: сначала сам заголовок статьи, потом соседние статьи, потому что они
  // уточняют версию («GPT-6.1» рядом с «GPT-6»).
  const titles = [...new Set([best.title, ...relevant.map((item) => item.title)])].slice(0, 3);
  return {
    canonical: best.title,
    titles,
    description: best.snippet || null,
    source: "wikipedia",
  };
}

/**
 * Собирает поисковые запросы из распознанной сущности.
 *
 * Возвращает короткие точные формулировки вместо длинных конъюнкций: бесплатные движки
 * на длинном запросе расходятся по случайным словам. Если сущность не распознана,
 * список пуст — конвейер продолжит работать по плану исследования.
 */
export function entitySearchQueries(entity, topic) {
  if (!entity?.canonical) return [];
  const queries = [];
  const topicStems = stems(topic);
  const canonical = normalize(entity.canonical);
  // «GPT-6» + исходная различающая основа («astra») даёт ровно ту формулировку, которая
  // на замере вернула openai.com.
  if (topicStems.length) {
    const merged = `${canonical} ${topicStems.filter((stem) => !canonical.toLocaleLowerCase("ru-RU").includes(stem)).join(" ")}`;
    queries.push(normalize(merged));
  }
  queries.push(canonical);
  for (const title of entity.titles.slice(1)) queries.push(normalize(title));
  return [...new Set(queries.filter((query) => query.length >= 3))].slice(0, 3);
}
