// Д.4 — адаптация одного черновика под сеть (ТЗ 5.3).
// Канонический текст пишется с лёгкой разметкой:
//   ||текст||  — спойлер (скрытый текст)
//   **текст**  — жирный
// Telegram поддерживает и то, и другое. У VK спойлеров нет — они убираются
// (текст показывается обычным), жирный тоже снимается: wall.post — простой текст.

const SPOILER = /\|\|([\s\S]+?)\|\|/g;
const BOLD = /\*\*([\s\S]+?)\*\*/g;

/** Экранируем спецсимволы HTML, чтобы отдать Telegram parse_mode=HTML безопасно. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Версия для Telegram: наша разметка → HTML-теги Telegram. */
export function adaptForTelegram(text: string): { text: string; parseMode: "HTML" } {
  const html = escapeHtml(text)
    .replace(SPOILER, "<tg-spoiler>$1</tg-spoiler>")
    .replace(BOLD, "<b>$1</b>");
  return { text: html, parseMode: "HTML" };
}

/** Версия для VK: разметка снимается, остаётся чистый текст (спойлер «исчезает»). */
export function adaptForVk(text: string): string {
  return text.replace(SPOILER, "$1").replace(BOLD, "$1");
}

/** Единая точка: адаптировать текст под конкретную сеть. */
export function adaptText(text: string, network: "tg" | "vk"): string {
  return network === "vk" ? adaptForVk(text) : adaptForTelegram(text).text;
}
