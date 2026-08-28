import { describe, expect, it } from "vitest";

import {
  BOT_HELP_TEXT,
  COMPETITOR_MECHANIC_ACTION_LABEL,
  formatBotCalendar,
  formatBotApprovals,
  formatBotClientInbox,
  formatBotChannelConnectPrompt,
  formatBotConnectionOnboarding,
  formatBotConnectionStatus,
  formatBotDisconnectConfirmation,
  formatBotDraftPreview,
  formatBotMenu,
  formatBotNotificationSettings,
  formatBotProblems,
  formatBotResults,
  formatBotToday,
} from "./bot-copy.mjs";

describe("Telegram competitor action copy", () => {
  it("uses the platform-neutral action label", () => {
    expect(COMPETITOR_MECHANIC_ACTION_LABEL).toBe("Создать пост по механике");
    expect(COMPETITOR_MECHANIC_ACTION_LABEL).not.toContain("Сними это");
  });
});

describe("Telegram daily control summary", () => {
  it("names every consequential state instead of relying on emoji", () => {
    const message = formatBotToday({
      projectName: "Aurora Media",
      timezone: "Europe/Moscow",
      scheduledToday: 3,
      scheduledFuture: 8,
      published24h: 4,
      failed: 2,
      reconnect: 1,
      upcoming: [{ scheduledAt: "2026-08-15T07:00:00.000Z", network: "tg", channel: "Новости" }],
    });

    expect(message).toContain("Аврора сегодня");
    expect(message).toContain("3 публикации");
    expect(message).toContain("2 ошибки публикаций");
    expect(message).toContain("1 канал нужно переподключить");
    expect(message).toContain("10:00 — Telegram · Новости");
  });

  it("shows a clear next step when the day is empty", () => {
    const message = formatBotToday({ scheduledToday: 0, failed: 0, reconnect: 0, upcoming: [] });
    expect(message).toContain("работают без подтверждённых ошибок");
    expect(message).toContain("ничего не запланировано");
  });

  it("documents the pocket workflow through buttons instead of commands", () => {
    expect(BOT_HELP_TEXT).toContain("Используй кнопки под полем ввода");
    expect(BOT_HELP_TEXT).toContain("Показать сегодня");
    expect(BOT_HELP_TEXT).toContain("Создать пост");
    expect(BOT_HELP_TEXT).toContain("Уведомления");
    expect(BOT_HELP_TEXT).not.toContain("/menu");
    expect(BOT_HELP_TEXT).toContain("добавить Telegram-канал прямо из бота");
  });
});

describe("Telegram connection center copy", () => {
  it("explains the no-website native channel connection", () => {
    const message = formatBotChannelConnectPrompt({ projectName: "Аврора" });
    expect(message).toContain("Проект: Аврора");
    expect(message).toContain("Возвращаться на сайт");
    expect(message).toContain("публиковать сообщения");
  });

  it("names every independent connection state in plain language", () => {
    const message = formatBotConnectionStatus({
      accountLabel: "eg***@example.com",
      commandState: "conflict",
      publicationState: "up",
      projectName: "Аврора",
      activeChannels: 2,
      reconnectChannels: 1,
      notificationState: "partial",
      checkedAt: "14:32",
    });
    expect(message).toContain("Аккаунт: eg***@example.com");
    expect(message).toContain("Приём команд: ошибка — команды принимает второй процесс");
    expect(message).toContain("Публикации: работают");
    expect(message).toContain("Каналы: подключено — 2; нужно переподключить — 1");
    expect(message).toContain("Уведомления: включены частично");
    expect(message).toContain("Защищённая очередь автоматически восстанавливает приём команд");
    expect(message).toContain("переподключать чат не нужно");
  });

  it("explains linking and disconnection consequences without relying on color", () => {
    expect(formatBotConnectionOnboarding({ available: true })).toContain("Ссылка действует 15 минут");
    expect(formatBotConnectionOnboarding({ available: true, localLink: true }))
      .toContain("на компьютере, где запущена Аврора");
    expect(formatBotConnectionOnboarding({ disconnected: true })).toContain("Проекты и публикации сохранены");
    expect(formatBotDisconnectConfirmation()).toContain("Команды и уведомления в Telegram остановятся");
  });
});

describe("Telegram pocket workspace copy", () => {
  it("describes the selected project and publishing capability", () => {
    expect(formatBotMenu({ projectName: "Аврора", channelCount: 2, role: "owner" }))
      .toContain("поставить публикацию в очередь");
    expect(formatBotMenu({ projectName: "Аврора", channelCount: 1, role: "author" }))
      .toContain("подготовить черновик для команды");
    expect(formatBotMenu({ projectName: "Аврора", channelCount: 1, role: "publisher" }))
      .not.toContain("подготовить текст");
    expect(formatBotMenu({ projectName: "Аврора", channelCount: 1, role: "owner" }))
      .toContain("Выбери действие кнопкой ниже");
  });

  it("states notification ON values and the project timezone", () => {
    const message = formatBotNotificationSettings({
      projectName: "Аврора",
      timezone: "Europe/Moscow",
      publicationSuccessEnabled: true,
      publicationFailureEnabled: false,
      contentOpportunitiesEnabled: true,
      dailyDigestEnabled: true,
      dailyDigestHour: 9,
      weeklyDigestEnabled: true,
    });
    expect(message).toContain("Успешные публикации: включено");
    expect(message).toContain("Ошибки и переподключения: выключено");
    expect(message).toContain("в 09:00");
    expect(message).toContain("Europe/Moscow");
  });

  it("makes the publish boundary explicit in the draft preview", () => {
    const message = formatBotDraftPreview({
      project: "Аврора",
      channel: "Новости",
      text: "Точный текст поста",
      version: 3,
      canPublish: true,
    });
    expect(message).toContain("Точный текст поста");
    expect(message).toContain("Проект: Аврора");
    expect(message).toContain("До нажатия кнопки публикация не начнётся");
  });

  it("shows a useful empty calendar state", () => {
    expect(formatBotCalendar({ projectName: "Аврора", timezone: "UTC", items: [] }))
      .toContain("Создай пост");
  });
});

describe("Telegram decision screens", () => {
  it("shows the author and exact review queue position", () => {
    const message = formatBotApprovals({ projectName: "Аврора", items: [{ channel: "Новости", author: "Анна", text: "Текст", age: "2 часа назад" }] });
    expect(message).toContain("Новости · Анна");
    expect(message).toContain("2 часа назад");
  });

  it("distinguishes a healthy workspace from actionable problems", () => {
    expect(formatBotProblems({ projectName: "Аврора" })).toContain("Подтверждённых проблем нет");
    expect(formatBotProblems({ failed: 2, reviews: 3 })).toContain("Ошибки публикаций: 2");
    expect(formatBotProblems({ failed: 2, reviews: 3 })).toContain("Тексты ждут согласования: 3");
  });

  it("explains performance relative to a baseline", () => {
    const message = formatBotResults({ items: [{ channel: "Новости", views: 1500, lift: 1.5, text: "Сильный пост" }] });
    expect(message).toContain("выше обычного в 1,5×");
    expect(message).toContain("Сильный пост");
  });

  it("keeps client replies behind a human send decision", () => {
    const disabled = formatBotClientInbox({ projectName: "Аврора", enabled: false });
    expect(disabled).toContain("Клиентский помощник выключен");
    const ready = formatBotClientInbox({ canSend: true, enabled: true, items: [{ incoming: "Сколько стоит?", reply: "Уточните, пожалуйста, услугу." }] });
    expect(ready).toContain("Черновик ответа");
    expect(ready).toContain("только после нажатия отдельной кнопки");

    const unknown = formatBotClientInbox({
      canSend: true,
      enabled: true,
      items: [{ incoming: "Сколько стоит?", reply: "Уточните услугу.", deliveryUnknown: true }],
    });
    expect(unknown).toContain("Результат прошлой отправки неизвестен");

    const author = formatBotClientInbox({
      canEdit: true,
      canSend: false,
      enabled: true,
      items: [{ incoming: "Сколько стоит?" }],
    });
    expect(author).toContain("Ты можешь подготовить ответ");
  });
});
