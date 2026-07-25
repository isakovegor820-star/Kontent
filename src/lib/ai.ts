// Демо-ИИ. Настоящий продукт зовёт API Claude/GPT (ТЗ, раздел 9).
// Здесь — шаблонный генератор с посимвольной выдачей, чтобы «ИИ печатает» выглядело
// и ощущалось так же, как в живом демо лендинга (ТЗ 7.4, уровень 3).

import type { Competitor, Trend } from "./types";

export type AiCommand =
  | "write" // напиши пост на тему
  | "rewrite" // перепиши
  | "shorten" // сократи
  | "plan" // план на неделю
  | "script" // сценарий видео
  | "image" // картинка
  | "poll" // опрос
  | "longread"; // лонгрид

const HOOKS = [
  "Раньше я думал, что дело в зёрнах. Оказалось — нет.",
  "Три года я делал это неправильно. Показываю, как надо.",
  "Самая частая ошибка стоит тебе денег каждую неделю.",
  "Это займёт 40 секунд и изменит твой утренний кофе.",
  "Никто не говорит об этом вслух, а зря.",
];

const CLOSERS = [
  "А ты как делаешь? Расскажи в комментариях — интересно сравнить.",
  "Сохрани, чтобы не забыть перед следующей покупкой.",
  "Если было полезно — поделись с тем, кто тоже мучается.",
  "Что из этого попробуешь первым?",
];

const pick = <T,>(arr: T[], salt = 0) => arr[(Math.floor(Math.random() * arr.length) + salt) % arr.length];

/** Пост на тему, с опорой на разведку — ключевая связка ТЗ 5.6 */
export function generatePost(topic: string, ctx?: { competitor?: Competitor; trend?: Trend }) {
  const hook = ctx?.trend?.hook ?? pick(HOOKS);
  const body = ctx?.competitor
    ? `Разобрал, почему у «${ctx.competitor.name}» это зашло: ${ctx.competitor.topFormats[0]?.name.toLowerCase() ?? "короткое видео"} даёт им вовлечённость ${ctx.competitor.er}%. Пересказываю своими словами и на своём опыте.`
    : `Коротко о главном по теме «${topic}». Без воды: только то, что реально работает, проверено на себе.`;

  return [
    hook,
    "",
    body,
    "",
    `Три вещи, которые стоит знать про «${topic.toLowerCase()}»:`,
    "1. Начни с простого — дорогое железо не спасёт от плохой базы.",
    "2. Меняй один параметр за раз, иначе не поймёшь, что сработало.",
    "3. Записывай, что получилось. Через месяц скажешь спасибо.",
    "",
    pick(CLOSERS),
  ].join("\n");
}

export function rewritePost(text: string) {
  const first = text.split("\n")[0] ?? "";
  return [
    pick(HOOKS),
    "",
    "Переписал живее и короче — суть та же, но читается легче:",
    "",
    first.replace(/^[^а-яА-Я]*/, "").slice(0, 140),
    "",
    pick(CLOSERS),
  ].join("\n");
}

export function shortenPost(text: string) {
  const sentences = text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
  return sentences.slice(0, 2).join(" ") + (sentences.length > 2 ? "" : "");
}

export function generateScript(topic: string) {
  return [
    `Сценарий видео: «${topic}»`,
    "",
    "0–3 сек. Хук. Говоришь прямо в камеру, без вступления.",
    `   «${pick(HOOKS)}»`,
    "3–15 сек. Показываешь проблему крупным планом. Молча, звук фона.",
    "15–30 сек. Решение. Одно действие — одна фраза.",
    "30–40 сек. Итог и вопрос зрителю.",
    "",
    "Совет: не монтируй красиво. Сырое видео сейчас заходит лучше отполированного.",
  ].join("\n");
}

export function generateWeekPlan() {
  return [
    "План на неделю — 5 постов:",
    "",
    "Пн 08:00 · Утренний вопрос (приём конкурента, ER 12,1%)",
    "Вт 19:00 · Разбор ошибки (залёт ×7,8 — тема горького кофе)",
    "Ср 12:00 · Личная история (твой формат, стабильно держит охват)",
    "Пт 13:00 · Карусель «5 ошибок» (вечнозелёное, ×4,2)",
    "Сб 11:00 · День без монтажа (общий тренд сетей, ×3,1)",
    "",
    "Всё построено на данных разведки за последние 7 дней. Одобряешь — уйдёт в календарь.",
  ].join("\n");
}

export function run(cmd: AiCommand, input: string, ctx?: { competitor?: Competitor; trend?: Trend }) {
  switch (cmd) {
    case "write":
      return generatePost(input || "твоя тема", ctx);
    case "rewrite":
      return rewritePost(input);
    case "shorten":
      return shortenPost(input);
    case "script":
      return generateScript(input || "твоя тема");
    case "plan":
      return generateWeekPlan();
    case "image":
      return "Готовлю картинку: горизонталь для VK 1200×630 и квадрат для Telegram. Размеры подставятся сами — ничего резать руками не нужно.";
    default:
      return "";
  }
}

/**
 * Посимвольная выдача. Возвращает функцию отмены — анимация никогда не блокирует
 * действие пользователя (ТЗ 7.4, общие правила).
 */
export function stream(
  text: string,
  onChunk: (partial: string) => void,
  onDone?: () => void,
  speed = 12,
) {
  let i = 0;
  let cancelled = false;

  const tick = () => {
    if (cancelled) return;
    // Печатаем «пачками» — так плавнее и дешевле для рендера
    i = Math.min(text.length, i + Math.ceil(Math.random() * 3) + 1);
    onChunk(text.slice(0, i));
    if (i < text.length) {
      setTimeout(tick, speed + Math.random() * speed);
    } else {
      onDone?.();
    }
  };

  setTimeout(tick, 180);
  return () => {
    cancelled = true;
  };
}
