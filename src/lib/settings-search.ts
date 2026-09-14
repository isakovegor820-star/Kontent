export type SettingsSectionId = "profile" | "project" | "channels" | "content" | "autopilot" | "dictionary" | "integrations" | "notifications";
export type SettingSearchEntry = { id: string; section: SettingsSectionId; label: string; aliases: string; target: string };

/** Search destinations are explicit, shared links to the actual setting, never copies of its value. */
export const SETTINGS_SEARCH_ENTRIES: SettingSearchEntry[] = [
  {"id": "appearance", "section": "profile", "label": "Тема оформления", "aliases": "светлая темная системная внешний вид цвет фон режим оформления", "target": "[id$=\"-theme\"]"},
  {"id": "avatar", "section": "profile", "label": "Фотография профиля", "aliases": "аватар фото картинка изображение загрузить заменить", "target": "input[type=\"file\"]"},
  {"id": "name", "section": "profile", "label": "Имя и описание", "aliases": "имя фамилия должность биография аккаунт", "target": "[id$=\"-display-name\"]"},
  {"id": "language", "section": "profile", "label": "Язык интерфейса", "aliases": "русский английский language локализация", "target": "[id$=\"-locale\"]"},
  {"id": "timezone", "section": "profile", "label": "Личный часовой пояс", "aliases": "время часы timezone", "target": "[id$=\"-timezone\"]"},
  {"id": "email", "section": "profile", "label": "Email", "aliases": "электронная почта адрес контакт письмо", "target": "input[aria-label=\"Новый email\"]"},
  {"id": "phone", "section": "profile", "label": "Телефон", "aliases": "номер контакт смс sms", "target": "[data-setting-target=\"phone\"]"},
  {"id": "project-name", "section": "project", "label": "Название проекта", "aliases": "переименовать рабочее пространство", "target": "#project-settings-name"},
  {"id": "project-time", "section": "project", "label": "Часовой пояс проекта", "aliases": "время расписание всех каналов", "target": "#project-settings-timezone"},
  {"id": "team", "section": "project", "label": "Участники проекта", "aliases": "команда доступ приглашение роль права", "target": "[data-setting-target=\"team\"]"},
  {"id": "limits", "section": "project", "label": "Лимиты ИИ", "aliases": "бюджет генерации токены расход квота", "target": "[data-setting-target=\"limits\"]"},
  {"id": "channels", "section": "channels", "label": "Подключённые каналы", "aliases": "telegram телеграм vk вк социальные сети подключение", "target": "[data-setting-target=\"channels\"]"},
  {"id": "copy", "section": "channels", "label": "Копирование настроек", "aliases": "перенос дублировать скопировать между каналами", "target": "#copy-source"},
  {"id": "preview", "section": "content", "label": "Проверить настройки", "aliases": "тест пример поста предпросмотр пробная генерация", "target": "#preview-topic"},
  {"id": "autopilot", "section": "autopilot", "label": "Режим автопилота", "aliases": "автоматизация автопубликация автоматические публикации запуск планирование подтверждение расписание", "target": "[data-setting-target=\"autopilot\"]"},
  {"id": "dictionary", "section": "dictionary", "label": "Словарь бренда", "aliases": "термин правило слово замена канон написание", "target": "[data-setting-target=\"dictionary\"]"},
  {"id": "blocks", "section": "dictionary", "label": "Блоки публикаций", "aliases": "шаблон подпись комментарий заготовка дисклеймер повторяющийся текст", "target": "[data-setting-target=\"blocks\"]"},
  {"id": "utm", "section": "integrations", "label": "UTM-шаблоны", "aliases": "утм utm метка ссылка кампания шаблон источник переход откуда приходят заявки", "target": "[data-setting-target=\"utm\"]"},
  {"id": "tracking", "section": "integrations", "label": "Трекинг сайта", "aliases": "пиксель аналитика метрика домен адрес сайт конверсия атрибуция подключение", "target": "#project-tracking-origin"},
  {"id": "legal", "section": "integrations", "label": "Юридические источники", "aliases": "право законодательство oauth интеграции", "target": "[data-setting-target=\"legal\"]"},
  {"id": "bot", "section": "integrations", "label": "Telegram-бот", "aliases": "телеграм уведомления подключение бот сообщения", "target": "[data-setting-target=\"bot\"]"},
  {"id": "notifications", "section": "notifications", "label": "Доставка уведомлений", "aliases": "email telegram оповещение события письмо сообщение безопасность лимиты", "target": "[data-setting-target=\"notifications\"]"},
  {"id": "security", "section": "notifications", "label": "Пароль и вход", "aliases": "безопасность сессия выход пароль восстановление доступ", "target": "[data-setting-target=\"security\"]"},
  {"id": "quiet", "section": "notifications", "label": "Тихие часы", "aliases": "ночь публикации ночной перерыв время", "target": "[data-setting-target=\"quiet\"]"},
  {"id": "channel-niche", "section": "content", "label": "Тема и ниша", "aliases": "", "target": "#channel-niche"},
  {"id": "channel-audience", "section": "content", "label": "Аудитория и её задача", "aliases": "", "target": "#channel-audience"},
  {"id": "channel-goal", "section": "content", "label": "Цель канала", "aliases": "", "target": "#channel-goal"},
  {"id": "channel-author-role", "section": "content", "label": "Роль и экспертиза автора", "aliases": "", "target": "#channel-author-role"},
  {"id": "channel-cta", "section": "content", "label": "Следующий шаг читателя", "aliases": "", "target": "#channel-cta"},
  {"id": "channel-taboo", "section": "content", "label": "Запретные темы и обещания", "aliases": "", "target": "#channel-taboo"},
  {"id": "channel-persona", "section": "content", "label": "Роль / персона автора", "aliases": "", "target": "#channel-persona"},
  {"id": "channel-tone", "section": "content", "label": "Точное описание тона", "aliases": "", "target": "#channel-tone"},
  {"id": "channel-language-rules", "section": "content", "label": "Правила языка", "aliases": "", "target": "#channel-language-rules"},
  {"id": "channel-conclusion", "section": "content", "label": "Завершать содержательным выводом", "aliases": "", "target": "#channel-conclusion"},
  {"id": "channel-allowed-emoji", "section": "content", "label": "Разрешённые эмодзи", "aliases": "", "target": "#channel-allowed-emoji"},
  {"id": "channel-branded-hashtags", "section": "content", "label": "Фирменные хэштеги", "aliases": "", "target": "#channel-branded-hashtags"},
  {"id": "channel-link-rules", "section": "content", "label": "Правила ссылок и упоминаний", "aliases": "", "target": "#channel-link-rules"},
  {"id": "channel-visual-direction", "section": "content", "label": "Стиль визуала", "aliases": "", "target": "#channel-visual-direction"},
  {"id": "channel-autopilot-enabled", "section": "autopilot", "label": "Включить автопилот для этого канала", "aliases": "", "target": "#channel-autopilot-enabled"},
  {"id": "channel-autopilot-engine", "section": "autopilot", "label": "Модель для постов", "aliases": "", "target": "#channel-autopilot-engine"},
  {"id": "channel-competitor-topics", "section": "content", "label": "Разрешить темы конкурентов", "aliases": "", "target": "#channel-competitor-topics"},
  {"id": "channel-disclaimer-required", "section": "content", "label": "Обязательный дисклеймер", "aliases": "", "target": "#channel-disclaimer-required"},
  {"id": "channel-disclaimer", "section": "content", "label": "Текст дисклеймера", "aliases": "", "target": "#channel-disclaimer-required"},
  {"id": "channel-address", "section": "content", "label": "Обращение к аудитории", "aliases": "", "target": "#channel-address"},
  {"id": "channel-author-voice", "section": "content", "label": "Голос автора", "aliases": "", "target": "#channel-author-voice"},
  {"id": "channel-energy", "section": "content", "label": "Энергия текста", "aliases": "", "target": "#channel-energy"},
  {"id": "channel-warmth", "section": "content", "label": "Теплота", "aliases": "", "target": "#channel-warmth"},
  {"id": "channel-inspiration", "section": "content", "label": "Вдохновение и надежда", "aliases": "", "target": "#channel-inspiration"},
  {"id": "channel-provocation", "section": "content", "label": "Провокационность", "aliases": "", "target": "#channel-provocation"},
  {"id": "channel-formality", "section": "content", "label": "Стиль изложения", "aliases": "", "target": "#channel-formality"},
  {"id": "channel-expertise", "section": "content", "label": "Экспертность голоса", "aliases": "", "target": "#channel-expertise"},
  {"id": "channel-humor", "section": "content", "label": "Юмор и ирония", "aliases": "смешной шутка веселый серьезный", "target": "#channel-humor"},
  {"id": "channel-opinion", "section": "content", "label": "Острота мнения", "aliases": "", "target": "#channel-opinion"},
  {"id": "channel-profanity", "section": "content", "label": "Мат и грубая лексика", "aliases": "", "target": "#channel-profanity"},
  {"id": "channel-language-complexity", "section": "content", "label": "Сложность языка", "aliases": "", "target": "#channel-language-complexity"},
  {"id": "channel-originality", "section": "content", "label": "Уникальность / анти-клише", "aliases": "", "target": "#channel-originality"},
  {"id": "channel-min-length", "section": "content", "label": "Минимальная длина", "aliases": "", "target": "#channel-min-length"},
  {"id": "channel-max-length", "section": "content", "label": "Максимальная длина", "aliases": "короче короткий пост текст объем размер символы", "target": "#channel-max-length"},
  {"id": "channel-format-style", "section": "content", "label": "Основной формат подачи", "aliases": "", "target": "#channel-format-style"},
  {"id": "channel-sentence-rhythm", "section": "content", "label": "Ритм фраз", "aliases": "", "target": "#channel-sentence-rhythm"},
  {"id": "channel-paragraphs", "section": "content", "label": "Плотность абзацев", "aliases": "", "target": "#channel-paragraphs"},
  {"id": "channel-lists", "section": "content", "label": "Списки и чек-листы", "aliases": "", "target": "#channel-lists"},
  {"id": "channel-bold", "section": "content", "label": "Жирные акценты", "aliases": "", "target": "#channel-bold"},
  {"id": "channel-hook-style", "section": "content", "label": "Тип первой строки", "aliases": "", "target": "#channel-hook-style"},
  {"id": "channel-hook-intensity", "section": "content", "label": "Сила крючка", "aliases": "", "target": "#channel-hook-intensity"},
  {"id": "channel-hook-length", "section": "content", "label": "Длина первой строки", "aliases": "", "target": "#channel-hook-length"},
  {"id": "channel-quotes", "section": "content", "label": "Прямая речь и цитаты", "aliases": "", "target": "#channel-quotes"},
  {"id": "channel-scenes", "section": "content", "label": "Сценки и мини-истории", "aliases": "", "target": "#channel-scenes"},
  {"id": "channel-reader-dialogue", "section": "content", "label": "Диалог с читателем", "aliases": "", "target": "#channel-reader-dialogue"},
  {"id": "channel-facts-share", "section": "content", "label": "Опора на факты", "aliases": "", "target": "#channel-facts-share"},
  {"id": "channel-citations", "section": "content", "label": "Доля подтверждённых фактов", "aliases": "", "target": "#channel-citations"},
  {"id": "channel-personal-stories", "section": "content", "label": "Личные истории и опыт", "aliases": "", "target": "#channel-personal-stories"},
  {"id": "channel-trends", "section": "content", "label": "Привязка к актуальному", "aliases": "", "target": "#channel-trends"},
  {"id": "channel-audience-level", "section": "content", "label": "Уровень аудитории в теме", "aliases": "", "target": "#channel-audience-level"},
  {"id": "channel-post-goal", "section": "content", "label": "Главная цель поста", "aliases": "", "target": "#channel-post-goal"},
  {"id": "channel-sales", "section": "content", "label": "Продающесть / нативность", "aliases": "", "target": "#channel-sales"},
  {"id": "channel-cta-intensity", "section": "content", "label": "Интенсивность призыва", "aliases": "", "target": "#channel-cta-intensity"},
  {"id": "channel-cta-frequency", "section": "content", "label": "Частота призыва", "aliases": "", "target": "#channel-cta-frequency"},
  {"id": "channel-interactivity", "section": "content", "label": "Вовлечение / интерактив", "aliases": "", "target": "#channel-interactivity"},
  {"id": "channel-emojis", "section": "content", "label": "Максимум эмодзи", "aliases": "", "target": "#channel-emojis"},
  {"id": "channel-hashtags", "section": "content", "label": "Количество хэштегов", "aliases": "", "target": "#channel-hashtags"},
  {"id": "channel-source-links", "section": "content", "label": "Ссылки на источники", "aliases": "", "target": "#channel-source-links"},
  {"id": "channel-mentions", "section": "content", "label": "@Упоминания и прошлые посты", "aliases": "", "target": "#channel-mentions"},
  {"id": "channel-visuals", "section": "content", "label": "Частота визуального сопровождения", "aliases": "", "target": "#channel-visuals"},
  {"id": "channel-visual-detail", "section": "content", "label": "Детализация промпта для картинки", "aliases": "", "target": "#channel-visual-detail"},
  {"id": "channel-autopilot-frequency", "section": "autopilot", "label": "Постов в неделю", "aliases": "", "target": "#channel-autopilot-frequency"},
  {"id": "channel-autopilot-weeks", "section": "autopilot", "label": "Период одного плана", "aliases": "", "target": "#channel-autopilot-weeks"},
  {"id": "channel-autopilot-news", "section": "autopilot", "label": "Свежих событий в неделю", "aliases": "", "target": "#channel-autopilot-news"},
  {"id": "channel-autopilot-detail", "section": "autopilot", "label": "Объём постов", "aliases": "", "target": "#channel-autopilot-detail"},
  {"id": "channel-autopilot-energy", "section": "autopilot", "label": "Подача", "aliases": "", "target": "#channel-autopilot-energy"},
  {"id": "channel-autopilot-emoji", "section": "autopilot", "label": "Эмодзи", "aliases": "смайлик emoji", "target": "#channel-autopilot-emoji"},
  {"id": "channel-quality", "section": "content", "label": "Порог качества", "aliases": "", "target": "#channel-quality"},
  {"id": "channel-retries", "section": "content", "label": "Попытки автоматической редактуры", "aliases": "", "target": "#channel-retries"},
];

const STOP_WORDS = new Set(["как", "где", "для", "и", "в", "на", "по", "с", "из", "у", "к", "мне", "мой", "моя", "хочу", "нужно", "изменить", "настроить", "настройки", "включить", "выключить", "сменить", "чтобы", "были", "был", "была", "было", "стали", "сделать", "поменять", "можно", "ли", "более", "менее", "свой", "свои", "установить", "добавить", "убрать", "отключить", "без"]);
export function normalizeSettingsQuery(value: string): string {
  return value.toLocaleLowerCase("ru-RU").replace(/ё/gu, "е").replace(/утм/gu, "utm").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
function stem(word: string): string {
  if (word === "меток") return "метк";
  if (word.length <= 4) return word.length === 4 ? word.replace(/[ыиауяюео]$/u, "") : word;
  return word.length > 3 ? word.replace(/(?:иями|ами|ого|ему|ому|ыми|ими|ую|юю|ая|яя|ое|ее|ые|ие|ый|ий|ой|ов|ев|ам|ям|ах|ях|ом|ем|ы|и|а|я|у|ю|е|о)$/u, "") : word;
}
function near(left: string, right: string): boolean {
  if (Math.min(left.length, right.length) < 5 || Math.abs(left.length - right.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (left.length >= right.length) i++;
    if (right.length >= left.length) j++;
  }
  return edits + (left.length - i) + (right.length - j) <= 1;
}

export function searchSettings(query: string): SettingSearchEntry[] {
  const normalized = normalizeSettingsQuery(query);
  const tokens = normalized.split(" ").filter((word) => word && !STOP_WORDS.has(word));
  if (!tokens.length) return [];
  return SETTINGS_SEARCH_ENTRIES.map((entry) => {
    const label = normalizeSettingsQuery(entry.label);
    const words = normalizeSettingsQuery(`${entry.label} ${entry.aliases}`).split(" ");
    const matches = tokens.map((token) => {
      if (label.split(" ").includes(token)) return 12;
      if (words.includes(token)) return 8;
      const root = stem(token);
      if (words.some((word) => stem(word) === root || (root.length >= 3 && stem(word).startsWith(root)))) return 5;
      if (words.some((word) => near(root, stem(word)))) return 2;
      return 0;
    });
    const score = matches.every(Boolean) ? matches.reduce<number>((sum, n) => sum + n, 0) + (label === normalized ? 40 : 0) : 0;
    return { entry, score };
  }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score).map(({ entry }) => entry);
}
