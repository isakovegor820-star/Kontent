/** User-facing label for turning a competitor pattern into an original platform post. */
export const COMPETITOR_MECHANIC_ACTION_LABEL = "Создать пост по механике";

export const BOT_HELP_TEXT =
  "Я помогаю вести контент без постоянного входа в кабинет:\n\n" +
  "Используй кнопки под полем ввода:\n" +
  "• Показать сегодня — публикации и задачи на сегодня\n" +
  "• Создать пост — превратить идею, ссылку, пересланный пост или голос в черновик\n" +
  "• Согласовать — одобрить текст или вернуть его с комментарием\n" +
  "• Проверить проблемы — увидеть только то, что требует решения\n" +
  "• Показать результаты — сравнить последние посты с обычным уровнем\n" +
  "• Подключение — проверить аккаунт, приём команд, публикации и каналы\n" +
  "• Уведомления — выбрать, какие события присылать\n" +
  "• Ещё — календарь, аналитика, план, тренды и вопросы клиентов\n\n" +
  "Ничего не публикуется автоматически: перед отправкой я всегда показываю точный текст и прошу подтверждение.";

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

export function formatBotMenu(input) {
  const projectName = String(input?.projectName || "Текущий проект");
  const channelCount = count(input?.channelCount);
  const role = String(input?.role || "");
  const capability = role === "owner"
    ? "Здесь можно проверить день, подготовить текст и поставить публикацию в очередь."
    : role === "publisher"
      ? "Здесь можно проверить день, контролировать публикации и повторить неудачную отправку."
      : "Здесь можно проверить день и подготовить черновик для команды.";
  return [
    "✦ Аврора в Telegram",
    projectName,
    "",
    channelCount > 0
      ? `${channelCount} ${plural(channelCount, "канал подключён", "канала подключены", "каналов подключено")}.`
      : "Каналы пока не подключены.",
    capability,
    "",
    "Выбери действие кнопкой ниже.",
  ].join("\n");
}

function runtimeState(value, kind) {
  if (value === "up") return kind === "commands" ? "работает" : "работают";
  if (value === "conflict") return "ошибка — команды принимает второй процесс";
  if (value === "not_configured") return kind === "commands" ? "не настроен" : "не настроены";
  return kind === "commands" ? "нет свежего подтверждения" : "временно недоступны";
}

export function formatBotConnectionStatus(input) {
  const projectName = input?.projectName ? String(input.projectName) : "не выбран";
  const activeChannels = count(input?.activeChannels);
  const reconnectChannels = count(input?.reconnectChannels);
  const channelSummary = reconnectChannels > 0
    ? `подключено — ${activeChannels}; нужно переподключить — ${reconnectChannels}`
    : activeChannels > 0
      ? `подключено — ${activeChannels}`
      : "нет подключённых каналов";
  const notificationState = input?.notificationState === "off"
    ? "выключены"
    : input?.notificationState === "partial"
      ? "включены частично"
      : "включены";
  return [
    "✦ Подключение к Авроре",
    "",
    `Аккаунт: ${String(input?.accountLabel || "подключён")}`,
    `Приём команд: ${runtimeState(input?.commandState, "commands")}`,
    `Публикации: ${runtimeState(input?.publicationState, "publication")}`,
    `Проект: ${projectName}`,
    `Каналы: ${channelSummary}`,
    `Уведомления: ${notificationState}`,
    `Последняя проверка: ${String(input?.checkedAt || "только что")}`,
    "",
    input?.commandState === "conflict"
      ? "Связь с аккаунтом сохранена. Администратору нужно остановить старый worker или заменить токен бота; переподключать чат не нужно."
      : "Выбери действие ниже.",
  ].join("\n");
}

export function formatBotConnectionOnboarding(input) {
  const disconnected = input?.disconnected === true;
  const available = input?.available !== false;
  return [
    disconnected ? "Чат отключён от Авроры" : "✦ Подключение к Авроре",
    "",
    disconnected
      ? "Команды и уведомления в этом чате остановлены. Проекты и публикации сохранены."
      : "Этот чат пока не связан с аккаунтом Авроры.",
    "",
    available
      ? "Нажми «Подключить аккаунт», войди в Аврору и подтверди этот чат. Ссылка действует 15 минут."
      : "Подключение из Telegram пока недоступно. Открой настройки Авроры и выбери «Подключить бота».",
  ].join("\n");
}

export function formatBotProjectPicker(input) {
  const projects = Array.isArray(input?.projects) ? input.projects : [];
  if (projects.length === 0) {
    return "У тебя пока нет доступных проектов. Создай проект в Авроре и повтори проверку.";
  }
  return [
    "Проект для команд Telegram",
    "",
    "Выбери проект. Новые команды, черновики и уведомления будут относиться к нему.",
    projects.length > 10 ? "Показаны первые 10 проектов." : "",
  ].filter(Boolean).join("\n");
}

export function formatBotDisconnectConfirmation() {
  return [
    "Отключить этот чат?",
    "",
    "Команды и уведомления в Telegram остановятся. Проекты, каналы и публикации останутся в Авроре.",
  ].join("\n");
}

export function formatBotIntakePrompt(input) {
  return [
    "✦ Новый пост",
    `Проект: ${String(input?.projectName || "Текущий проект")}`,
    `Канал: ${String(input?.channelName || "Канал")}`,
    "",
    "С чего начнём? Можно прислать идею, готовый текст, ссылку, пересланный пост или голосовое сообщение.",
    "",
    "Сначала я подготовлю черновик. До отдельного подтверждения ничего не будет опубликовано.",
  ].join("\n");
}

export function formatBotApprovals(input) {
  const items = Array.isArray(input?.items) ? input.items.slice(0, 8) : [];
  const lines = ["✓ Согласование", String(input?.projectName || "Текущий проект")];
  if (!items.length) {
    lines.push("", "Новых текстов на согласовании нет.", "Когда коллега отправит черновик, он появится здесь с точной версией и автором.");
    return lines.join("\n");
  }
  lines.push("", `${items.length} ${plural(items.length, "текст ждёт", "текста ждут", "текстов ждут")} решения:`);
  for (const [index, item] of items.entries()) {
    lines.push("", `${index + 1}. ${String(item?.channel || "Канал")} · ${String(item?.author || "Автор")}`);
    lines.push(String(item?.text || "Без текста").replace(/\s+/gu, " ").slice(0, 180));
    lines.push(`Отправлен: ${String(item?.age || "недавно")}`);
  }
  return lines.join("\n");
}

export function formatBotProblems(input) {
  const failed = count(input?.failed);
  const reconnect = count(input?.reconnect);
  const reviews = count(input?.reviews);
  const unscheduled = count(input?.unscheduled);
  const lines = ["⚠️ Требует внимания", String(input?.projectName || "Текущий проект"), ""];
  if (failed + reconnect + reviews + unscheduled === 0) {
    lines.push("🟢 Подтверждённых проблем нет.", "Публикации, подключения и очередь согласований в порядке.");
    return lines.join("\n");
  }
  if (failed) lines.push(`• Ошибки публикаций: ${failed}`);
  if (reconnect) lines.push(`• Каналы нужно переподключить: ${reconnect}`);
  if (reviews) lines.push(`• Тексты ждут согласования: ${reviews}`);
  if (unscheduled) lines.push(`• Готовые черновики без даты: ${unscheduled}`);
  lines.push("", "Выбери проблему ниже — покажу безопасное следующее действие.");
  return lines.join("\n");
}

export function formatBotResults(input) {
  const items = Array.isArray(input?.items) ? input.items.slice(0, 5) : [];
  const lines = ["↗ Результаты постов", String(input?.projectName || "Текущий проект")];
  if (!items.length) {
    lines.push("", "Пока нет постов с собранной статистикой.", "Обычно первые честные выводы появляются через сутки после публикации.");
    return lines.join("\n");
  }
  for (const item of items) {
    const lift = Number(item?.lift);
    const comparison = Number.isFinite(lift)
      ? lift >= 1.15 ? `выше обычного в ${lift.toLocaleString("ru-RU")}×`
        : lift <= 0.85 ? `ниже обычного, ${Math.round(lift * 100)}% от нормы`
          : "примерно на обычном уровне"
      : "база для сравнения ещё собирается";
    lines.push("", `${String(item?.channel || "Канал")} · ${count(item?.views).toLocaleString("ru-RU")} просмотров`);
    lines.push(`${comparison}. ${String(item?.text || "Пост").replace(/\s+/gu, " ").slice(0, 130)}`);
  }
  lines.push("", "Можно повторить механику, сделать продолжение или адаптировать лучший пост — только после просмотра черновика.");
  return lines.join("\n");
}

export function formatBotClientInbox(input) {
  const items = Array.isArray(input?.items) ? input.items.slice(0, 8) : [];
  const lines = ["💬 Вопросы клиентов", String(input?.projectName || "Текущий проект")];
  if (!input?.enabled) {
    lines.push("", "Клиентский помощник выключен.", "Он начнёт принимать обращения только после подключения Telegram Business. Каждый ответ всё равно потребует подтверждения человека.");
    return lines.join("\n");
  }
  if (!items.length) {
    lines.push("", "Новых вопросов нет.", "Когда клиент напишет, сообщение появится здесь без автоматического ответа.");
    return lines.join("\n");
  }
  for (const [index, item] of items.entries()) {
    lines.push("", `${index + 1}. ${String(item?.incoming || "Сообщение").replace(/\s+/gu, " ").slice(0, 220)}`);
    if (item?.reply) lines.push(`Черновик ответа: ${String(item.reply).replace(/\s+/gu, " ").slice(0, 300)}`);
    else lines.push("Ответ ещё не подготовлен.");
    if (item?.deliveryUnknown) {
      lines.push("Результат прошлой отправки неизвестен. Сначала проверь переписку в Telegram.");
    } else if (item?.status === "approved") {
      lines.push("Telegram подтверждает отправку. Повтор пока заблокирован.");
    }
  }
  lines.push(
    "",
    input?.canSend
      ? "Отправка произойдёт только после нажатия отдельной кнопки."
      : input?.canEdit
        ? "Ты можешь подготовить ответ. Отправит его согласующий, издатель или владелец проекта."
        : "Ты можешь проверить входящие. Отправит ответ согласующий, издатель или владелец проекта.",
  );
  return lines.join("\n");
}

export function formatBotNotificationSettings(input) {
  const enabled = (value) => value === false ? "выключено" : "включено";
  const hour = Math.max(0, Math.min(23, Number(input?.dailyDigestHour) || 0));
  return [
    "🔔 Уведомления",
    String(input?.projectName || "Текущий проект"),
    "",
    `Успешные публикации: ${enabled(input?.publicationSuccessEnabled)}`,
    `Ошибки и переподключения: ${enabled(input?.publicationFailureEnabled)}`,
    `Идеи и тренды: ${enabled(input?.contentOpportunitiesEnabled)}`,
    `Результаты постов: ${enabled(input?.postResultsEnabled)}`,
    `Напоминания о согласовании: ${enabled(input?.reviewRemindersEnabled)}`,
    `Сводка проблем: ${enabled(input?.problemDigestEnabled)}`,
    `Утренняя сводка: ${enabled(input?.dailyDigestEnabled)}${input?.dailyDigestEnabled === false ? "" : `, в ${String(hour).padStart(2, "0")}:00`}`,
    `Итоги недели: ${enabled(input?.weeklyDigestEnabled)}`,
    "",
    `Время указано для часового пояса ${String(input?.timezone || "UTC")}.`,
  ].join("\n");
}

export function formatBotDraftPreview(input) {
  const text = String(input?.text || "").trim();
  const project = String(input?.project || "Текущий проект");
  const channel = String(input?.channel || "Канал");
  const version = count(input?.version) || 1;
  return [
    "📝 Проверь публикацию",
    `Проект: ${project}`,
    `Канал: ${channel}`,
    `Версия: ${version}`,
    "",
    text,
    "",
    input?.canPublish
      ? "Выбери, когда поставить её в очередь. До нажатия кнопки публикация не начнётся."
      : "Черновик сохранён. Отправить его в канал сможет владелец или издатель проекта.",
  ].join("\n");
}

export function formatBotCalendar(input) {
  const timezone = String(input?.timezone || "UTC");
  const items = Array.isArray(input?.items) ? input.items.slice(0, 10) : [];
  const lines = [
    "🗓 Ближайшие публикации",
    String(input?.projectName || "Текущий проект"),
    `Часовой пояс: ${timezone}`,
  ];
  if (items.length === 0) {
    lines.push("", "В очереди пока ничего нет. Создай пост — и он появится здесь.");
    return lines.join("\n");
  }
  for (const item of items) {
    const network = NETWORK_LABEL[item?.network] || String(item?.network || "Соцсеть");
    const channel = String(item?.channel || "Канал");
    const date = new Date(item?.scheduledAt);
    const when = Number.isFinite(date.getTime())
      ? date.toLocaleString("ru-RU", {
          timeZone: timezone,
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "время не подтверждено";
    lines.push("", `${when} — ${network} · ${channel}`);
  }
  return lines.join("\n");
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
  const reviews = count(input?.reviews);
  const unscheduled = count(input?.unscheduled);
  const timezone = String(input?.timezone || "UTC");
  const lines = [
    "✦ Аврора сегодня",
    String(input?.projectName || "Текущий проект"),
    "",
    `📝 Сегодня: ${scheduledToday} ${plural(scheduledToday, "публикация", "публикации", "публикаций")}`,
    `⏳ В очереди: ${scheduledFuture}`,
    `✅ Опубликовано за 24 часа: ${published24h}`,
  ];

  if (failed > 0 || reconnect > 0 || reviews > 0 || unscheduled > 0) {
    lines.push("");
    lines.push("⚠️ Требует внимания:");
    if (failed > 0) lines.push(`• ${failed} ${plural(failed, "ошибка публикации", "ошибки публикаций", "ошибок публикаций")}`);
    if (reconnect > 0) lines.push(`• ${reconnect} ${plural(reconnect, "канал нужно переподключить", "канала нужно переподключить", "каналов нужно переподключить")}`);
    if (reviews > 0) lines.push(`• ${reviews} ${plural(reviews, "текст ждёт согласования", "текста ждут согласования", "текстов ждут согласования")}`);
    if (unscheduled > 0) lines.push(`• ${unscheduled} ${plural(unscheduled, "черновик без даты", "черновика без даты", "черновиков без даты")}`);
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
