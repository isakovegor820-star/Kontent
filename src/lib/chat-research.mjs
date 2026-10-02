// Нужно ли Авроре идти в интернет, прежде чем отвечать в чате.
//
// Зачем отдельный модуль: без него либо каждый запрос тянет сеть (медленно и дорого),
// либо ни один — и тогда на «напиши пост о выходе новой модели OpenAI» Аврора честно
// отвечает «не знаю названия» и задаёт встречный вопрос вместо работы.
//
// Модуль чистый: только текст на входе и решение на выходе.

export const CHAT_RESEARCH_REASONS = Object.freeze([
  "content_request",
  "external_event",
  "freshness",
  "legal",
  "statistics",
  "benchmark",
  "explicit_request",
]);

export const CHAT_RESEARCH_REASON_LABELS = Object.freeze({
  content_request: "Запрос на пост по внешней теме",
  external_event: "Событие во внешнем мире",
  freshness: "Нужны свежие данные",
  legal: "Норма права",
  statistics: "Статистика",
  benchmark: "Бенчмарк",
  explicit_request: "Пользователь прямо просит проверить",
});

/** Запросы о самой платформе и её содержимом: сеть здесь не нужна и вредна. */
const INTERNAL_ONLY = [
  /(?:что|чего) ты (?:умеешь|можешь)/iu,
  /как (?:настроить|подключить|работает) (?:канал|аврора|платформ|автопилот|студи)/iu,
  // «наши рубрики», «мои посты», «наш контент-план» — это содержимое канала,
  // а не внешний мир: искать такое в интернете бессмысленно.
  /(?:наши|наша|наше|наш[аи]?|мои|моя|моё|мое|моего|своего|свои)\s+(?:рубрик|тем|пост|публикац|черновик|канал|аудитор|подписчик|контент|план|профил|стил|голос|паспорт)/iu,
  /(?:контент-план|редполитик|рубрикатор|паспорт канала)/iu,
  /(?:перепиши|сократи|сделай короче|сделай длиннее|поменяй тон|другими словами|исправь)/iu,
];

/** Чисто редакторские команды: правят уже готовый текст, фактов не добавляют. */
const EDIT_ONLY = /^(?:сократи|сделай короче|сделай длиннее|перепиши|поменяй тон|сделай мягче|сделай жёстче|убери|добавь хэштег|поставь эмодзи)/iu;

/** Внешнее событие: что-то произошло в мире, и об этом надо рассказать. */
const EXTERNAL_EVENT = [
  /(?:выход|вышел|вышл[аи]|выпустил[аи]?|запустил[аи]?|представил[аи]?|анонсировал[аи]?|объявил[аи]?|релиз|релизнул)/iu,
  /(?:новая|новый|новое|новые)\s+(?:модел|верси|продукт|устройств|сервис|функци|тариф|стандарт)/iu,
  /(?:обновлени|обновил|обновилась|апдейт|update)/iu,
  /(?:купил|поглотил|слияни|банкрот|уход[аи]т|назначен|уволен)/iu,
  /(?:исследовани|отчёт|отчет|доклад|прогноз)/iu,
];

/** Маркеры свежести: пользователь явно ждёт актуальных данных. */
const FRESHNESS = [
  /(?:актуальн|последн|свеж|новост|сегодня|вчера|на этой неделе|только что|недавн)/iu,
  /(?:проверь|уточни|найди|поищи|погугли|посмотри|узнай|выясни)/iu,
  /20\d{2}\s*(?:год|года)?/iu,
];

/** Норма права. */
const LEGAL = [
  /(?:закон|законопроект|постановлени|указ|приказ|регламент|поправк|кодекс|фз\b|фз\s*№)/iu,
  /(?:вступ(?:ает|ил)[аи]? в силу|принят[а]? в (?:первом|втором|третьем) чтении|внес[её]н[а]? в госдуму)/iu,
  /(?:роскомнадзор|фас|фнс|мин(?:цифры|труд|фин)|центробанк|цб рф|верховн(?:ый|ого) суд)/iu,
];

/** Статистика и цифры внешнего мира. */
const STATISTICS = [
  /(?:статистик|исследовани|опрос|данные|доля|процент|рынок|выручк|оборот|инфляци)/iu,
  /\d+\s*(?:%|процент|млрд|млн|тыс)/iu,
];

/** Бенчмарк: сравнение моделей, устройств, сервисов по измерениям. */
const BENCHMARK = [
  /(?:бенчмарк|benchmark|тест(?:ы|ов)?|замер|сравнени|быстрее|медленнее|точность|производительн)/iu,
  /(?:mmLU|GPQA|SWE-bench|HumanEval|AIME|ARC-AGI|токен(?:ов)? в секунду)/iu,
];

/**
 * Запрос на создание текста. Для таких запросов интернет нужен по умолчанию:
 * пользователь просит написать пост о теме, а не переписать уже готовое.
 * Именно здесь ломался сценарий «напиши пост о выходе новой модели OpenAI» —
 * Аврора не шла в сеть и вместо поста задавала встречный вопрос.
 *
 * Границы слов заданы через `\p{L}`, а не `\b`: в JavaScript `\b` и `\w` определены
 * только по ASCII и на кириллице не срабатывают вовсе.
 */
const CONTENT_REQUEST = /(?:напиши|сделай|подготовь|создай|сгенерируй|составь|придумай|нужен|нужна|хочу)\s+(?:мне\s+)?(?:пост|публикаци\p{L}*|лонгрид|заметк\p{L}*|обзор|анонс|новост\p{L}*|текст|сценари\p{L}*|опрос)(?!\p{L})/iu;

/** Издательская обёртка в начале запроса: её не должно быть в поисковом запросе. */
const EDITORIAL_PREFIX = /^(?:напиши|сделай|подготовь|создай|сгенерируй|составь|придумай)\s+(?:мне\s+)?(?:пост|публикаци\p{L}*|текст|лонгрид|заметк\p{L}*|обзор|анонс|новост\p{L}*)(?!\p{L})[\s\-—:,.]*/iu;

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function normalize(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

/**
 * Тема для поиска: из команды вида «напиши пост - о выходе новой модель от OpenAi»
 * нужно получить «выходе новой модель OpenAi», а не всю команду целиком —
 * иначе поисковик получит «напиши пост» и вернёт мусор.
 */
export function chatResearchTopic(value) {
  let text = normalize(value);
  if (!text) return "";
  // Отрезаем издательскую обёртку в начале.
  text = text.replace(EDITORIAL_PREFIX, "");
  // «- о выходе…», «про выход…», «на тему…» — тоже обёртка.
  text = text.replace(/^(?:на\s+тему|о|об|про|по теме)\s+/iu, "");
  const cleaned = normalize(text).replace(/^[\s\-—:,.;]+/u, "").replace(/[\s\-—:,.;]+$/u, "");
  return (cleaned || normalize(value)).slice(0, 300);
}

/**
 * Решение о походе в интернет.
 *
 * @param {object} input
 * @param {string} [input.task]    текст задачи пользователя
 * @param {string} [input.surface] поверхность запроса
 * @param {Array<{role?: string, text?: string, content?: string}>} [input.history]
 * @returns {{needed: boolean, reasons: string[], topic: string, categories: string[], confidence: number}}
 */
export function detectChatResearchNeed(input = {}) {
  const raw = normalize(input.task ?? input.input ?? "");
  const history = Array.isArray(input.history) ? input.history : [];
  // Короткая реплика вида «да», «продолжай» наследует тему предыдущего запроса.
  const previousUser = [...history].reverse()
    .find((turn) => String(turn?.role ?? "") === "user" && normalize(turn?.text ?? turn?.content ?? ""));
  const previousText = normalize(previousUser?.text ?? previousUser?.content ?? "");
  const combined = raw.length >= 24 || !previousText ? raw : `${previousText} ${raw}`;

  const topic = chatResearchTopic(combined);
  const empty = { needed: false, reasons: [], topic, categories: [], confidence: 0 };
  if (!combined) return empty;

  if (EDIT_ONLY.test(combined)) return empty;
  if (matchesAny(combined, INTERNAL_ONLY) && !matchesAny(combined, FRESHNESS)) {
    // «перепиши наши посты» — это про содержимое канала, а не про внешний мир.
    if (!matchesAny(combined, EXTERNAL_EVENT) && !matchesAny(combined, LEGAL)) return empty;
  }

  const reasons = [];
  const contentRequest = CONTENT_REQUEST.test(combined);
  if (contentRequest) reasons.push("content_request");
  if (matchesAny(combined, EXTERNAL_EVENT)) reasons.push("external_event");
  if (matchesAny(combined, FRESHNESS)) reasons.push("freshness");
  if (matchesAny(combined, LEGAL)) reasons.push("legal");
  if (matchesAny(combined, STATISTICS)) reasons.push("statistics");
  if (matchesAny(combined, BENCHMARK)) reasons.push("benchmark");

  const explicit = /(?:проверь|найди|поищи|погугли|посмотри|узнай|выясни|актуальн|последн|свеж)/iu.test(combined);
  if (explicit) reasons.push("explicit_request");

  const unique = [...new Set(reasons)];
  const categories = [];
  if (unique.includes("legal")) categories.push("law");
  if (unique.includes("benchmark")) categories.push("benchmark");
  if (unique.includes("statistics")) categories.push("statistics");
  if (!categories.length) categories.push("market", "technology");

  // Порядок приоритета решений:
  //   1. запрос на пост по внешней теме → в сеть всегда (это и есть просьба «для каждой темы»);
  //   2. сильный признак внешнего мира (событие, свежесть, право, цифры) → в сеть;
  //   3. явная просьба проверить → в сеть.
  // Внутренние темы канала и чистая редактура отсекаются выше и сюда не доходят.
  const strong = unique.filter((reason) => reason !== "explicit_request" && reason !== "content_request");
  const needed = contentRequest || strong.length > 0 || unique.includes("explicit_request");

  // Уверенность: одного слабого совпадения мало, но запрос на пост — уже достаточное основание.
  const confidence = contentRequest
    ? Math.min(1, 0.5 + strong.length * 0.2 + (explicit ? 0.2 : 0))
    : Math.min(1, strong.length * 0.4 + (explicit ? 0.3 : 0));

  return {
    needed: needed && confidence >= 0.3,
    reasons: unique,
    topic,
    categories: categories.slice(0, 3),
    confidence: Math.round(confidence * 100) / 100,
  };
}

/** Готовая строка для журнала: пользователь должен видеть, почему Аврора пошла в сеть. */
export function chatResearchReasonText(reasons) {
  const labels = (Array.isArray(reasons) ? reasons : [])
    .map((reason) => CHAT_RESEARCH_REASON_LABELS[reason])
    .filter(Boolean);
  return labels.length ? labels.join(", ") : "Тема требует внешних данных";
}

/**
 * Выключатель выхода в интернет.
 *
 * По умолчанию включён: именно ради этого поведения всё и делалось. Выключать нужно
 * ровно в двух случаях — когда владелец платформы сознательно отключает функцию
 * переменной окружения и когда код исполняется под тестовым раннером. Второе важно
 * не ради скорости: `safe-http` ходит через `node:https`, минуя подменённый в тестах
 * `global.fetch`, поэтому без этого предохранителя прогон тестов открывал бы реальные
 * соединения с чужими сайтами.
 */
export function chatResearchEnabled(env = {}) {
  const explicit = String(env?.AURORA_CHAT_RESEARCH ?? "").trim().toLowerCase();
  if (["off", "false", "0", "disabled"].includes(explicit)) return false;
  if (["on", "true", "1", "enabled"].includes(explicit)) return true;
  // Явного решения нет: под тестами молчим, в бою работаем.
  return !env?.VITEST;
}
