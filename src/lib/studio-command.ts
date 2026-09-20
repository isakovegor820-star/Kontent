import type { AiCommand } from "./ai";

/** Определяет формат по явной команде, не путая «вопрос» с «опросом». */
export function pickStudioCommand(text: string): AiCommand {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.some((word) => word.startsWith("план"))) return "plan";
  if (words.some((word) => word.startsWith("сценар") || word.startsWith("видео"))) return "script";
  if (words.some((word) => word.startsWith("сократ") || word === "короче")) return "shorten";
  if (words.some((word) => word.startsWith("перепиш"))) return "rewrite";
  if (words.some((word) => word.startsWith("картинк"))) return "image";
  if (words.some((word) => /^опрос(?:ы|а|у|ом|е|ов|ами|ах)?$/u.test(word) || word.startsWith("голосован"))) {
    return "poll";
  }
  if (words.some((word) => word.startsWith("лонгрид") || word.startsWith("длинн"))) return "longread";
  return "write";
}

export function looksLikeStudioEditFollowUp(text: string): boolean {
  if (/^(?:сделай|давай)\s+(?:(?:новый|новую|новое)\s|(?:пост|публикацию|текст)\s+(?:о|об|про|на тему)(?=\s|$))/iu.test(text.trim())) return false;
  return /^(сделай|исправь|убери|добавь|замени|оставь|измени|поменяй|перестрой|давай|без|больше|меньше|ещё|слишком)(?=$|[^\p{L}\p{N}_])/iu.test(text.trim());
}
