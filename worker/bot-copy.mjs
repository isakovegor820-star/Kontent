/** User-facing label for turning a competitor pattern into an original platform post. */
export const COMPETITOR_MECHANIC_ACTION_LABEL = "Создать пост по механике";

export const BOT_HELP_TEXT =
  "Я помогаю контролировать контент без постоянного входа в кабинет:\n\n" +
  "/today — публикации и задачи на сегодня\n" +
  "/create — перейти к созданию поста\n" +
  "/plan — проверить план недели\n" +
  "/stats — цифры каналов за неделю\n" +
  "/trends — что зашло у конкурентов\n\n" +
  "Я также напишу, если публикация выйдет, завершится ошибкой или потребует повторной отправки.";

const NETWORK_LABEL = {
  tg: "Telegram",
  vk: "VK",
  instagram: "Instagram",
  youtube: "YouTube",
  x: "X",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
};

function count(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}

function plural(value, one, few, many) {
  const n = Math.abs(count(value));
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

function localTime(value, timezone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "время не подтверждено";
  try {
    return date.toLocaleString("ru-RU", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return date.toLocaleString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }
}

export function formatBotToday(input) {
  const scheduledToday = count(input?.scheduledToday);
  const scheduledFuture = count(input?.scheduledFuture);
  const published24h = count(input?.published24h);
  const failed = count(input?.failed);
  const reconnect = count(input?.reconnect);
  const timezone = String(input?.timezone || "UTC");
  const lines = [
    "✦ Аврора сегодня",
    String(input?.projectName || "Текущий проект"),
    "",
    `📝 Сегодня: ${scheduledToday} ${plural(scheduledToday, "публикация", "публикации", "публикаций")}`,
    `⏳ В очереди: ${scheduledFuture}`,
    `✅ Опубликовано за 24 часа: ${published24h}`,
  ];

  if (failed > 0 || reconnect > 0) {
    lines.push("");
    lines.push("⚠️ Требует внимания:");
    if (failed > 0) lines.push(`• ${failed} ${plural(failed, "ошибка публикации", "ошибки публикаций", "ошибок публикаций")}`);
    if (reconnect > 0) lines.push(`• ${reconnect} ${plural(reconnect, "канал нужно переподключить", "канала нужно переподключить", "каналов нужно переподключить")}`);
  } else {
    lines.push("", "🟢 Публикации и подключения работают без подтверждённых ошибок.");
  }

  const upcoming = Array.isArray(input?.upcoming) ? input.upcoming.slice(0, 4) : [];
  if (upcoming.length > 0) {
    lines.push("", `Ближайшие · ${timezone}`);
    for (const item of upcoming) {
      const network = NETWORK_LABEL[item?.network] || String(item?.network || "Соцсеть");
      const channel = String(item?.channel || "канал");
      lines.push(`${localTime(item?.scheduledAt, timezone)} — ${network} · ${channel}`);
    }
  } else if (scheduledToday === 0) {
    lines.push("", "На сегодня ничего не запланировано. Можно подготовить следующий пост заранее.");
  }

  return lines.join("\n");
}
