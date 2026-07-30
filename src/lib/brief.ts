/**
 * Потолок постов в неделю. Живёт здесь, а не в lib/autopilot: тот тянет pg и bullmq, а
 * страница автопилота клиентская — импорт утащил бы серверные пакеты в браузерный бандл.
 * Этот файл чистый, его знают обе стороны.
 *
 * Число выбирает человек — это не наш вкус. Но предел физический, и врать про него нельзя:
 * план собирает ИИ последовательно, по одному посту за вызов, до 90 секунд на вызов. 30 постов
 * — это уже до получаса генерации на одного человека, и всё это время воркер не публикует
 * остальным. Снять предел можно, только распараллелив генерацию, — это отдельная работа,
 * а не смена цифры.
 * ВАЖНО: держать в синхроне с MAX_WEEKLY_POSTS в worker.mjs (TS туда не импортируется).
 */
export const MAX_WEEKLY_POSTS = 30;

// Бриф контента (ТЗ Д.9) — единственный источник правды о том, ЧТО за канал.
// До него автопилот писал вслепую: в ИИ уходило «Напиши пост на тему: Полезный
// совет по твоей теме», и модель выдумывала что попало. Теперь ниша, аудитория,
// цель и стоп-темы едут в каждый запрос — и в темы недели, и в текст поста.
//
// Этот файл знают и приложение, и воркер. Стандарт качества лежит в чистом .mjs-модуле,
// поэтому обе стороны используют один и тот же контракт без расходящихся копий.

import {
  DEFAULT_POST_QUALITY,
  normalizePostQuality,
  type PostQuality,
} from "./post-quality.mjs";

export interface Brief {
  niche: string; // о чём канал
  audience: string; // для кого
  rubrics: string[]; // рубрики/форматы, которые чередуем
  goal: string; // зачем канал автору
  cta: string; // куда ведём читателя
  taboo: string; // о чём не писать никогда
  quality: PostQuality; // как именно писать и что программно блокировать
  ready: boolean; // подтверждён пользователем глазами
  source: "ai" | "manual" | "quiz" | null; // честно: чем заполнен
}

export const EMPTY_BRIEF: Brief = {
  niche: "",
  audience: "",
  rubrics: [],
  goal: "",
  cta: "",
  taboo: "",
  quality: { ...DEFAULT_POST_QUALITY },
  ready: false,
  source: null,
};

/** Рубрики = ФОРМАТ поста, а не тема. Формат + ниша → конкретная тема на неделю. */
export const RUBRICS: { key: string; label: string; emoji: string }[] = [
  { key: "tip", label: "Полезный совет", emoji: "💡" },
  { key: "story", label: "Личная история", emoji: "📖" },
  { key: "mistake", label: "Разбор ошибки", emoji: "⚠️" },
  { key: "question", label: "Ответ на вопрос", emoji: "❓" },
  { key: "howto", label: "Инструкция по шагам", emoji: "📋" },
  { key: "case", label: "Разбор кейса", emoji: "🔍" },
  { key: "digest", label: "Итоги и подборки", emoji: "📊" },
  { key: "myth", label: "Мифы и правда", emoji: "🎭" },
  { key: "backstage", label: "За кулисами", emoji: "🎬" },
];

export const RUBRIC_LABELS = RUBRICS.map((r) => r.label);

const LIMITS = { niche: 300, audience: 300, goal: 300, cta: 300, taboo: 600, rubric: 60 };

const clean = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

/** Приводим что угодно (тело запроса, ответ ИИ, строка БД) к валидному брифу. */
export function normalizeBrief(raw: unknown): Brief {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rubrics = Array.isArray(r.rubrics)
    ? [...new Set(r.rubrics.map((x) => clean(x, LIMITS.rubric)).filter(Boolean))].slice(0, 10)
    : [];
  return {
    niche: clean(r.niche, LIMITS.niche),
    audience: clean(r.audience, LIMITS.audience),
    rubrics,
    goal: clean(r.goal, LIMITS.goal),
    cta: clean(r.cta, LIMITS.cta),
    taboo: clean(r.taboo, LIMITS.taboo),
    quality: normalizePostQuality(r.quality),
    ready: r.ready === true,
    source: r.source === "ai" || r.source === "manual" || r.source === "quiz" ? r.source : null,
  };
}

/** Минимум, без которого ИИ снова начнёт выдумывать: о чём канал и для кого. */
export function briefComplete(b: Brief): boolean {
  return b.niche.trim().length >= 3 && b.audience.trim().length >= 3;
}

/**
 * Блок про канал для системной инструкции ИИ. Пустые поля пропускаем — не гоним
 * в модель «цель: не указано», это только шумит.
 */
export function briefContext(b: Brief): string {
  const lines: string[] = ["О канале, для которого пишешь:", `— тема: ${b.niche}`];
  if (b.audience) lines.push(`— читатель: ${b.audience}`);
  if (b.goal) lines.push(`— зачем автор ведёт канал: ${b.goal}`);
  if (b.cta) lines.push(`— куда ведём читателя: ${b.cta}`);
  if (b.rubrics.length) lines.push(`— рубрики канала: ${b.rubrics.join(", ")}`);
  if (b.taboo) lines.push("", `Категорически не пиши про: ${b.taboo}`);
  lines.push(
    "",
    "Пиши предметно и по этой теме. Никаких общих слов про «твою тему» — только конкретика ниши.",
  );
  return lines.join("\n");
}
