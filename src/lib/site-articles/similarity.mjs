/**
 * Проверка смыслового дубля. Два контура: векторный (pgvector, когда эмбеддинги доступны)
 * и лексический (шинглы слов + косинус tf), который работает всегда и без сети.
 * Пороги векторного контура — из спецификации (0.86 / 0.78); лексические откалиброваны
 * на фикстурах в similarity.test.mjs.
 */

export const SIMILARITY_THRESHOLDS = Object.freeze({
  vector: Object.freeze({ reject: 0.86, warn: 0.78 }),
  lexical: Object.freeze({ reject: 0.55, warn: 0.32 }),
});

const STOP = new Set([
  "и", "в", "во", "не", "что", "он", "на", "я", "с", "со", "как", "а", "то", "все", "она", "так", "его", "но", "да", "ты",
  "к", "у", "же", "вы", "за", "бы", "по", "только", "ее", "мне", "было", "вот", "от", "меня", "еще", "нет", "о", "из",
  "ему", "теперь", "когда", "даже", "ну", "вдруг", "ли", "если", "уже", "или", "ни", "быть", "был", "него", "до", "вас",
  "нибудь", "опять", "уж", "вам", "ведь", "там", "потом", "себя", "ничего", "ей", "может", "они", "тут", "где", "есть",
  "надо", "ней", "для", "мы", "тебя", "их", "чем", "была", "сам", "чтоб", "без", "будто", "чего", "раз", "тоже", "себе",
  "под", "будет", "ж", "тогда", "кто", "этот", "того", "потому", "этого", "какой", "совсем", "ним", "здесь", "этом",
  "один", "почти", "мой", "тем", "чтобы", "нее", "сейчас", "были", "куда", "зачем", "всех", "никогда", "можно", "при",
  "наконец", "два", "об", "другой", "хоть", "после", "над", "больше", "тот", "через", "эти", "нас", "про", "всего", "них",
  "какая", "много", "разве", "три", "эту", "моя", "впрочем", "хорошо", "свою", "этой", "перед", "иногда", "лучше", "чуть",
  "том", "нельзя", "такой", "им", "более", "всегда", "конечно", "всю", "между", "это", "the", "and", "for", "with", "that",
]);

export function tokenize(text) {
  return (String(text || "").toLocaleLowerCase("ru-RU").match(/[a-zа-яё0-9][a-zа-яё0-9-]*/giu) || [])
    .filter((token) => token.length > 2 && !STOP.has(token))
    // Грубый стемминг: срезаем русские окончания, чтобы «имплантация»/«имплантации» совпали.
    .map((token) => (/[а-яё]/iu.test(token) && token.length > 6 ? token.replace(/(?:иями|ями|ами|ого|ему|ому|ыми|ими|ах|ях|ов|ев|ей|ой|ый|ий|ая|яя|ое|ее|ию|ие|ия|ии|ых|их|ам|ям|ом|ем|ы|и|а|я|у|ю|е|о)$/u, "") : token));
}

export function shingles(tokens, size = 3) {
  const out = new Set();
  for (let index = 0; index + size <= tokens.length; index += 1) out.add(tokens.slice(index, index + size).join(" "));
  return out;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function cosineTf(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;
  const count = (tokens) => {
    const map = new Map();
    for (const token of tokens) map.set(token, (map.get(token) || 0) + 1);
    return map;
  };
  const a = count(tokensA);
  const b = count(tokensB);
  let dot = 0;
  for (const [token, weight] of a) if (b.has(token)) dot += weight * b.get(token);
  const norm = (map) => Math.sqrt([...map.values()].reduce((sum, value) => sum + value * value, 0));
  return dot / (norm(a) * norm(b));
}

/** Лексическая близость двух текстов в [0, 1]: среднее шинглов и косинуса tf. */
export function lexicalSimilarity(textA, textB) {
  const tokensA = tokenize(textA);
  const tokensB = tokenize(textB);
  if (tokensA.length < 20 || tokensB.length < 20) return cosineTf(tokensA, tokensB) * 0.6;
  const shingleScore = jaccard(shingles(tokensA), shingles(tokensB));
  const cosine = cosineTf(tokensA, tokensB);
  return Math.min(1, 0.5 * shingleScore + 0.5 * cosine);
}

function verdictFor(score, thresholds) {
  if (score >= thresholds.reject) return "reject";
  if (score >= thresholds.warn) return "warn";
  return "ok";
}

/**
 * Сравнивает кандидата с корпусом (страницы сайта + уже опубликованные материалы).
 * `vectorScores` — уже посчитанные косинусные близости [{url, score}], если эмбеддинги доступны;
 * решение принимается по худшему из контуров.
 */
export function checkSimilarity({ candidateText, corpus = [], vectorScores = null }) {
  let best = { score: 0, url: null, method: "lexical" };
  for (const item of corpus) {
    const score = lexicalSimilarity(candidateText, item.text);
    if (score > best.score) best = { score, url: item.url || null, method: "lexical" };
  }
  const lexicalVerdict = verdictFor(best.score, SIMILARITY_THRESHOLDS.lexical);
  let vectorVerdict = "ok";
  let vectorBest = null;
  if (Array.isArray(vectorScores) && vectorScores.length) {
    vectorBest = vectorScores.reduce((top, item) => (Number(item.score) > Number(top?.score ?? -1) ? item : top), null);
    vectorVerdict = verdictFor(Number(vectorBest.score), SIMILARITY_THRESHOLDS.vector);
  }
  const order = { ok: 0, warn: 1, reject: 2 };
  const verdict = order[vectorVerdict] >= order[lexicalVerdict] ? vectorVerdict : lexicalVerdict;
  const chosen = verdict === vectorVerdict && vectorBest && order[vectorVerdict] >= order[lexicalVerdict]
    ? { score: Number(vectorBest.score), url: vectorBest.url || null, method: "vector" }
    : best;
  return Object.freeze({
    verdict,
    maxScore: Number(chosen.score.toFixed(4)),
    nearestUrl: chosen.url,
    method: chosen.method,
    lexical: Object.freeze({ score: Number(best.score.toFixed(4)), url: best.url, verdict: lexicalVerdict }),
    vector: vectorBest ? Object.freeze({ score: Number(Number(vectorBest.score).toFixed(4)), url: vectorBest.url || null, verdict: vectorVerdict }) : null,
    checkedAt: new Date().toISOString(),
  });
}
