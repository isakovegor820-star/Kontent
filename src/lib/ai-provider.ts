// Переходник ИИ (ТЗ Д.8). Единый внутренний интерфейс, за которым — любой движок.
// Остальной код (роут, студия, автопилот) зовёт только этот файл и не знает, кто внутри.
//
// ДВА движка за одним интерфейсом, выбор автоматический:
//   • Облако (OpenAI-совместимое): включается, как только задан AI_API_KEY. Работает с
//     OpenAI, OpenRouter, Together, локальным vLLM и т.п. Отличный русский из коробки.
//   • Локальный Ollama (модель hermes3): дефолт, пока ключа нет. Бесплатно, на этой машине.
// Сменить движок = поменять переменные окружения (ключ/URL/модель), КОД НЕ ТРОГАЕМ.

import { moodPrompt, moodTemp } from "./moods";

const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const OLLAMA_MODEL = process.env.AI_MODEL || "hermes3";

const CLOUD_KEY = process.env.AI_API_KEY || "";
const CLOUD_URL = (process.env.AI_API_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const CLOUD_MODEL = process.env.AI_CLOUD_MODEL || "gpt-4o-mini";

export type AiEngine = "cloud" | "local" | "none";

/** Какой движок активен сейчас. Облако — как только есть ключ; иначе локальный Hermes. */
export function activeEngine(): AiEngine {
  if (CLOUD_KEY) return "cloud";
  return "local"; // окончательно «none» решает aiReady() — вдруг Ollama не запущен
}

/** Человеческая метка движка для честного показа в интерфейсе. */
export function engineInfo(): { engine: AiEngine; model: string; label: string } {
  if (CLOUD_KEY) return { engine: "cloud", model: CLOUD_MODEL, label: `Облако (${CLOUD_MODEL})` };
  return { engine: "local", model: OLLAMA_MODEL, label: `Локально (${OLLAMA_MODEL})` };
}

export type AiKind = "write" | "rewrite" | "shorten" | "plan" | "script" | "image" | "poll" | "longread";

export type AiRole = "copywriter" | "strategist" | "critic";

export interface GenerateParams {
  kind: AiKind;
  task: string; // тема или текст от пользователя
  styleSamples?: string[]; // 5–10 прошлых постов как образец стиля (ТЗ Д.8)
  context?: string; // данные разведки/залёта (Д.6–Д.7), если есть
  niche?: string;
  tone?: string;
  mood?: string; // настроение агента (ключ из moods.ts) — задаёт персону + температуру
  role?: AiRole; // роль ИИ: копирайтер / стратег / критик
}

/** Жив ли движок. Облако — считаем доступным при наличии ключа (реальную ошибку поймает
 *  сам запрос). Локальный — пингуем Ollama и проверяем, что модель скачана. */
export async function aiReady(): Promise<boolean> {
  if (CLOUD_KEY) return true;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return false;
    const data = (await res.json()) as { models?: { name?: string }[] };
    const base = OLLAMA_MODEL.split(":")[0];
    return (data.models ?? []).some((m) => (m.name ?? "").split(":")[0] === base);
  } catch {
    return false;
  }
}

// Системная инструкция — держим тон на «ты» и грамотный русский (главный принцип ТЗ).
function systemPrompt(p: GenerateParams): string {
  const lines = [
    "Ты — редактор Telegram- и VK-каналов. Пишешь только на русском языке, живо и грамотно, как носитель.",
    "",
    "Жёсткие правила:",
    "— обращайся к читателю на «ты», без «Здравствуйте» и любых приветствий;",
    "— используй только существующие русские слова; не выдумывай и не коверкай слова;",
    "— короткие абзацы, простые живые фразы, без канцелярита и штампов;",
    "— не добавляй хэштеги и подпись, если об этом не просят;",
    "— выдай ТОЛЬКО текст поста, без пояснений и заголовков вроде «Пост:».",
  ];

  // Роль ИИ: модифицирует поведение модели.
  if (p.role === "copywriter") {
    lines.push("", "Роль: копирайтер. Пиши цепляющие тексты с сильным хуком в первой строке и чётким CTA в конце. Фокус на вовлечение.");
  } else if (p.role === "strategist") {
    lines.push("", "Роль: стратег. Давай структуру контент-стратегии: темы, форматы, частота, воронка. Мысли системно, а не одним постом.");
  } else if (p.role === "critic") {
    lines.push("", "Роль: злой читатель-критик. Разбери текст честно и жёстко: найди слабые места, скажи что бесит, где потерял внимание. Предложи конкретные правки.");
  }

  if (p.niche) lines.push("", `Ниша канала: ${p.niche}.`);
  if (p.tone) lines.push(`Тон автора: ${p.tone}.`);
  if (p.mood) lines.push(moodPrompt(p.mood)); // настроение агента (радостный/дерзкий/…)

  const samples = (p.styleSamples ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 10);
  if (samples.length) {
    lines.push("", "Вот примеры постов автора — держись его манеры, длины и тона (не копируй дословно):");
    for (const s of samples) lines.push("---", s);
    lines.push("---");
  }
  return lines.join("\n");
}

function userPrompt(p: GenerateParams): string {
  const ctx = p.context ? `\n\nОпирайся на данные разведки: ${p.context}` : "";
  switch (p.kind) {
    case "write":
      return `Напиши пост на тему: ${p.task}.${ctx}`;
    case "rewrite":
      return `Перепиши этот пост живее и естественнее, смысл сохрани:\n\n${p.task}`;
    case "shorten":
      return `Сократи этот пост до 2–3 предложений, оставь только суть:\n\n${p.task}`;
    case "plan":
      return `Составь план публикаций на неделю: 5 постов, для каждого — день, время и короткая тема.${ctx}`;
    case "script":
      return `Придумай сценарий короткого видео на тему: ${p.task}. Структура: хук, 2–3 сцены, финал с вопросом зрителю.${ctx}`;
    case "poll":
      return `Придумай опрос для канала на тему: ${p.task}. Формат: вопрос + 4 варианта ответа (короткие, до 30 символов каждый). Добавь подводку в 1–2 предложения перед опросом.${ctx}`;
    case "longread":
      return `Напиши лонгрид (1500–2000 знаков) на тему: ${p.task}. Структура: цепляющее начало, 3–4 подзаголовка, конкретные примеры, вывод с CTA.${ctx}`;
    default:
      return p.task;
  }
}

function messagesFor(p: GenerateParams) {
  return [
    { role: "system", content: systemPrompt(p) },
    { role: "user", content: userPrompt(p) },
  ];
}

/* ------------------------------------------------------------ ЛОКАЛЬНЫЙ (Ollama) */

// Свой таймаут + сигнал вызывающего: не зависаем, если движок принял соединение и заглох.
function withTimeout(signal: AbortSignal | undefined, ms = 60_000): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function* streamOllama(p: GenerateParams, signal?: AbortSignal): AsyncGenerator<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: withTimeout(signal),
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: true,
      options: { temperature: moodTemp(p.mood), top_p: 0.9, num_predict: 450 },
      messages: messagesFor(p),
    }),
  });
  if (!res.ok || !res.body) throw new Error(`ollama ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let chunk: { message?: { content?: string }; done?: boolean; error?: string };
      try {
        chunk = JSON.parse(line);
      } catch {
        continue;
      }
      if (chunk.error) throw new Error(chunk.error);
      if (chunk.message?.content) yield chunk.message.content;
      if (chunk.done) return;
    }
  }
}

/* --------------------------------------------------------- ОБЛАКО (OpenAI-совместимое) */

async function* streamCloud(p: GenerateParams, signal?: AbortSignal): AsyncGenerator<string> {
  const res = await fetch(`${CLOUD_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${CLOUD_KEY}` },
    signal: withTimeout(signal),
    body: JSON.stringify({
      model: CLOUD_MODEL,
      stream: true,
      temperature: moodTemp(p.mood),
      messages: messagesFor(p),
    }),
  });
  if (!res.ok || !res.body) throw new Error(`cloud ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
        const piece = json.choices?.[0]?.delta?.content;
        if (piece) yield piece;
      } catch {
        /* пропускаем битую строку */
      }
    }
  }
}

/**
 * Генерация текста стримом (ТЗ Д.8 — «печатается по мере генерации»). Сам выбирает движок.
 * Бросает исключение, если движок недоступен — роут переводит это в честное сообщение.
 */
export function generateText(p: GenerateParams, signal?: AbortSignal): AsyncGenerator<string> {
  return CLOUD_KEY ? streamCloud(p, signal) : streamOllama(p, signal);
}

/**
 * Разовый ПОЛНЫЙ ответ, без стрима — для служебных задач, где нужен готовый результат
 * целиком (например, бриф канала в JSON). Движок выбирается там же, где и для стрима.
 */
export async function completeText(
  system: string,
  user: string,
  opts: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const { temperature = 0.4, maxTokens = 700, signal } = opts;
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  if (CLOUD_KEY) {
    const res = await fetch(`${CLOUD_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${CLOUD_KEY}` },
      signal: withTimeout(signal, 90_000),
      body: JSON.stringify({ model: CLOUD_MODEL, temperature, max_tokens: maxTokens, messages }),
    });
    if (!res.ok) throw new Error(`cloud ${res.status}`);
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return (j.choices?.[0]?.message?.content ?? "").trim();
  }

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: withTimeout(signal, 90_000),
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      options: { temperature, num_predict: maxTokens },
      messages,
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const j = (await res.json()) as { message?: { content?: string } };
  return (j.message?.content ?? "").trim();
}
