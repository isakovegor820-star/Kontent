// Мелкие помощники. Никаких зависимостей — держим бандл лёгким (ТЗ 8.2).

export function cn(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

export function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

/** 12 345 → «12 345» (узкий неразрывный пробел, как принято в русской типографике) */
export function fmtNum(n: number) {
  return new Intl.NumberFormat("ru-RU").format(Math.round(n));
}

/** 12345 → «12,3 тыс.» — для плотных карточек */
export function fmtCompact(n: number) {
  if (n < 1000) return String(Math.round(n));
  return new Intl.NumberFormat("ru-RU", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
}

export function fmtPct(n: number, withSign = false) {
  const v = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(Math.abs(n));
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${withSign ? sign : ""}${v}%`;
}

const MONTHS = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

const WEEKDAYS_SHORT = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
const WEEKDAYS_FULL = [
  "понедельник",
  "вторник",
  "среда",
  "четверг",
  "пятница",
  "суббота",
  "воскресенье",
];

export const weekdayShort = (i: number) => WEEKDAYS_SHORT[i];
export const weekdayFull = (i: number) => WEEKDAYS_FULL[i];

/** Понедельник — 0 (в JS воскресенье — 0, чиним) */
export function isoDay(d: Date) {
  return (d.getDay() + 6) % 7;
}

export function fmtDate(iso: string) {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function fmtTime(iso: string) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function fmtDateTime(iso: string) {
  return `${fmtDate(iso)}, ${fmtTime(iso)}`;
}

/** «2 часа назад», «вчера» — человеческий язык, как требует ТЗ 7.5 */
export function fmtAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "только что";
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ${plural(h, "час", "часа", "часов")} назад`;
  const d = Math.floor(h / 24);
  if (d === 1) return "вчера";
  if (d < 7) return `${d} ${plural(d, "день", "дня", "дней")} назад`;
  return fmtDate(iso);
}

export function plural(n: number, one: string, few: string, many: string) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

export function startOfWeek(d: Date) {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  r.setDate(r.getDate() - isoDay(r));
  return r;
}

export function addDays(d: Date, n: number) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function atTime(day: Date, time: string) {
  const [h, m] = time.split(":").map(Number);
  const r = new Date(day);
  r.setHours(h, m ?? 0, 0, 0);
  return r;
}

export const NETWORK_LABEL: Record<string, string> = {
  tg: "Telegram",
  vk: "VK",
  youtube: "YouTube",
  instagram: "Instagram",
  x: "X (Twitter)",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
};

/**
 * «ТехнологИИ Права» → «ТП». Односимвольные слова («и», «в») пропускаем — иначе
 * «Кофе и код» дало бы «КИ» вместо «КК».
 */
export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const meaningful = words.filter((w) => w.length > 1);
  const source = meaningful.length ? meaningful : words;
  return (
    source
      .slice(0, 2)
      .map((w) => w.charAt(0).toUpperCase())
      .join("") || "?"
  );
}

/**
 * Устойчивый оттенок канала по его id. Цвет здесь — ВТОРОЙ слой поверх инициалов,
 * а не носитель смысла: по WCAG 1.4.1 (уровень A) цвет не может быть единственным
 * признаком, а при 4+ каналах различимых по светлоте оттенков всё равно не хватает.
 * Светлоту держим одинаковой, чтобы не спорить с цветом статуса поста.
 */
export function channelHue(id: number | string) {
  const s = String(id);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Детерминированный псевдослучайный генератор — стабильные демо-данные без гидрационных расхождений */
export function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}
