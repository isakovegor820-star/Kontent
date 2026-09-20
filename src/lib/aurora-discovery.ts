import { APP_NAV_GROUPS, APP_ROUTES, isAppRouteActive, type AppNavRouteId } from "./app-routes";
import { normalizeSettingsQuery, searchSettings } from "./settings-search";

export type GuideStep = { title: string; body: string; target: string; unavailable: string };
type SectionHelp = { description: string; firstStep: string; aliases: string; steps?: GuideStep[] };

/** Reviewed product copy. Help never executes an action or sends a request to AI. */
export const SECTION_HELP: Record<AppNavRouteId, SectionHelp> = {
  today: { description: "Задачи и подсказки на сегодня: что подготовить, проверить и опубликовать.", firstStep: "Выберите задачу, с которой хотите начать рабочий день.", aliases: "главная задачи день сводка начать" },
  calendar: {
    description: "Расписание публикаций: планируйте посты, переносите даты и проверяйте статусы.",
    firstStep: "Выберите период и посмотрите запланированные публикации.", aliases: "план расписание запланировать публикацию пост перенести дату отложенный",
    steps: [
      { title: "Посмотрите расписание", body: "В календаре видны публикации выбранного периода. Откройте карточку, чтобы посмотреть её содержание и статус.", target: "#calendar-view-panel", unavailable: "Расписание появится после загрузки. Выберите вид календаря и нужный период." },
      { title: "Подготовьте новый пост", body: "«Новый пост» открывает редактор. Там можно подготовить текст и выбрать время публикации.", target: '[data-aurora-feature="publication"][data-aurora-action="created"]', unavailable: "Кнопка «Новый пост» доступна участникам с правом редактирования. Если её нет, проверьте свою роль в проекте." },
      { title: "Проверьте публикацию", body: "Откройте карточку поста и проверьте канал, дату и статус. Планирование и отправка выполняются только по вашему действию.", target: "[data-calendar-card]", unavailable: "Пока карточек нет. После сохранения первого поста он появится в календаре." },
    ],
  },
  studio: {
    description: "Подготовка контента с Авророй: обсуждайте идеи, создавайте тексты и изображения.",
    firstStep: "В чате опишите тему, аудиторию и желаемый результат.", aliases: "написать создать сгенерировать пост текст чат ии ai идея контент картинка изображение",
    steps: [
      { title: "Опишите задачу", body: "Напишите, какой пост нужен: тема, аудитория, цель и факты, которые нужно учесть.", target: "[data-chat-composer]", unavailable: "Переключитесь на «Чат», чтобы написать задачу Авроре." },
      { title: "Отправьте запрос", body: "Проверьте выбранный канал и настройки под полем сообщения. Кнопка со стрелкой отправляет запрос и использует лимит ИИ.", target: '[data-aurora-feature="generation"][data-aurora-action="requested"]', unavailable: "Кнопка отправки находится под сообщением в режиме «Чат». Она станет доступна после выбора модели и ввода задачи." },
      { title: "Проверьте ответ", body: "Прочитайте результат и при необходимости попросите Аврору уточнить текст. Перед публикацией проверьте факты и формулировки.", target: "#chat-workspace", unavailable: "История сообщений доступна в режиме «Чат»." },
    ],
  },
  autopilot: {
    description: "Подготовка контент-плана и постов для выбранного канала с проверкой перед добавлением в календарь.",
    firstStep: "Проверьте канал и параметры плана, затем запустите подготовку.", aliases: "автоматизация автоматически контент план собрать неделю месяц генерация автопубликация",
    steps: [
      { title: "Проверьте состояние канала", body: "В обзоре показано, готов ли канал к работе и что требует внимания. Начните с этих подсказок.", target: "#autopilot-hero-title", unavailable: "Обзор станет доступен после загрузки канала. Если канал ещё не подключён, начните с настроек каналов." },
      { title: "Посмотрите расписание", body: "Проверьте ближайшие публикации и период работы. Параметры подготовки можно изменить в настройках автопилота.", target: "#autopilot-schedule-title", unavailable: "Расписание появится после подключения канала и загрузки данных." },
      { title: "Проверьте подготовленные посты", body: "Откройте готовый план, проверьте тексты и даты, затем подтвердите подходящие публикации для календаря.", target: "#autopilot-attention-title, #autopilot-recent-title", unavailable: "Если планов ещё нет, нажмите «Собрать план». Подготовка использует ИИ; после неё здесь появятся результаты для проверки." },
    ],
  },
  composer: { description: "Редактор отдельного поста: текст, вложения, канал и параметры публикации.", firstStep: "Подготовьте текст и проверьте канал. Затем сохраните пост или выберите действие публикации.", aliases: "редактировать изменить черновик пост сохранить вложение" },
  library: { description: "Сохранённые идеи, примеры и референсы для будущего контента.", firstStep: "Откройте «Референсы» для поиска примеров или «Коллекцию» для работы с сохранёнными материалами.", aliases: "библиотека коллекция референсы примеры сохраненные идеи" },
  rss: { description: "Юридические новости и события, из которых можно подготовить материалы для аудитории.", firstStep: "Откройте подходящий инфоповод, изучите источник и сохраните его или используйте для поста.", aliases: "новости право закон rss инфоповод источник события" },
  knowledge: { description: "Материалы о вашей работе, на которые Аврора может опираться при подготовке контента.", firstStep: "Добавьте материал с важными фактами и дождитесь его обработки.", aliases: "документы загрузить материалы факты знания база" },
  recon: { description: "Наблюдение за конкурентами и трендами: темы, публикации и сигналы для новых идей.", firstStep: "Выберите конкурента для изучения или перейдите на вкладку трендов.", aliases: "конкуренты тренды разведка рынок наблюдение" },
  opportunities: { description: "Рекомендации по темам и действиям, которые могут помочь развитию вашего контента.", firstStep: "Откройте рекомендацию, изучите обоснование и выберите подходящее действие.", aliases: "возможности рекомендации темы карта" },
  radar: { description: "Поиск материалов и сигналов по интересующей теме.", firstStep: "Введите тему поиска, изучите результаты и сохраните полезное.", aliases: "радар искать материалы сигналы тема" },
  siteAnalysis: { description: "Анализ сайта с отчётом и рекомендациями по улучшению.", firstStep: "Укажите адрес сайта и запустите анализ. Отчёт появится после завершения обработки.", aliases: "анализ сайт аудит проверить seo отчет адрес" },
  sites: { description: "Подключённые сайты, подготовка статей и управление их публикацией.", firstStep: "Подключите сайт и проверьте соединение, прежде чем отправлять статьи.", aliases: "сайты wordpress статьи подключить публикация" },
  growth: { description: "Предложения по развитию с действиями и отслеживанием результата.", firstStep: "Изучите предложенное действие и выберите то, которое готовы выполнить.", aliases: "развитие рост продвижение действия" },
  analytics: { description: "Результаты публикаций и показатели, которые помогают оценить работу контента.", firstStep: "Выберите период и канал, затем сравните показатели публикаций.", aliases: "аналитика статистика результаты отчеты охваты просмотры итоги" },
  settings: {
    description: "Профиль, проект, каналы, стиль контента, автопилот и интеграции.",
    firstStep: "Выберите раздел настроек или найдите конкретный параметр через поиск.", aliases: "настройки профиль аккаунт канал подключить стиль тема команда",
    steps: [
      { title: "Найдите нужную настройку", body: "Внутри настроек есть поиск по параметрам. Например, введите «часовой пояс» или «стиль».", target: "[data-discovery-target=\"settings-search\"]", unavailable: "Поиск параметров находится в меню настроек." },
      { title: "Измените параметр", body: "Параметры выбранного раздела открываются в этой области. Обратите внимание, относится настройка к аккаунту, проекту или каналу.", target: ".settings-panel", unavailable: "Параметры появятся после загрузки выбранного раздела." },
      { title: "Сохраните изменения", body: "После редактирования проверьте изменения и нажмите кнопку сохранения в соответствующем блоке.", target: '[data-settings-dirty="true"]', unavailable: "Несохранённых изменений нет. Кнопка сохранения появится или станет доступна после редактирования параметра." },
    ],
  },
};

export type DiscoveryEntry = { id: string; sectionId: AppNavRouteId; kind: "section" | "action"; label: string; description: string; href: string; aliases: string };
export const DISCOVERY_SECTIONS: DiscoveryEntry[] = APP_NAV_GROUPS.flatMap((group) => group.routeIds.map((id) => ({
  id, sectionId: id, kind: "section" as const, label: APP_ROUTES[id].label,
  href: APP_ROUTES[id].href, description: SECTION_HELP[id].description, aliases: SECTION_HELP[id].aliases,
})));

export const DISCOVERY_ACTIONS: DiscoveryEntry[] = ([
  { id: "write-post", sectionId: "studio", label: "Написать пост", description: "Откройте чат и опишите задачу Авроре.", href: "/app/studio?mode=chat", aliases: "написать создать сгенерировать пост текст хочу" },
  { id: "schedule-post", sectionId: "calendar", label: "Запланировать публикацию", description: "Откройте календарь и выберите время для поста.", href: "/app/calendar", aliases: "запланировать публикацию пост отложить расписание" },
  { id: "connect-channel", sectionId: "settings", label: "Подключить канал", description: "Откройте настройки каналов и добавьте Telegram или VK.", href: "/app/settings?section=channels&setting=channels", aliases: "подключить канал телеграм telegram вк vk добавить" },
  { id: "create-media", sectionId: "studio", label: "Создать изображение", description: "Откройте инструменты изображений в студии.", href: "/app/studio?mode=media", aliases: "сгенерировать создать картинку изображение фото" },
  { id: "content-plan", sectionId: "autopilot", label: "Подготовить контент-план", description: "Откройте автопилот для подготовки тем и постов.", href: "/app/autopilot", aliases: "собрать подготовить контент план неделю месяц" },
  { id: "brand-style", sectionId: "settings", label: "Настроить стиль контента", description: "Задайте тон, аудиторию и правила текстов для канала.", href: "/app/settings?section=content", aliases: "настроить поменять стиль тон голос аудитория" },
  { id: "invite-team", sectionId: "settings", label: "Пригласить участника", description: "Откройте управление командой и доступом к проекту.", href: "/app/settings?section=project&setting=team", aliases: "пригласить добавить участника команду коллегу доступ права" },
] satisfies Omit<DiscoveryEntry, "kind">[]).map((entry) => ({ ...entry, kind: "action" }));

const STOP = new Set(["как", "где", "мне", "мой", "моя", "хочу", "нужно", "можно", "ли", "в", "на", "и", "или", "по", "для", "с", "это"]);
const stem = (word: string) => word.length > 4 ? word.replace(/(?:иями|ами|ого|ому|ить|ать|ять|ую|ая|ое|ые|ий|ый|ой|ов|ам|ах|ом|ы|и|а|я|у|ю|е|о)$/u, "") : word;

export function searchDiscovery(query: string): DiscoveryEntry[] {
  const normalized = normalizeSettingsQuery(query).slice(0, 200);
  if (!normalized) return [...DISCOVERY_ACTIONS.slice(0, 4), ...DISCOVERY_SECTIONS];
  const tokens = normalized.split(" ").filter((word) => !STOP.has(word));
  if (!tokens.length) return [];
  const ranked = [...DISCOVERY_ACTIONS, ...DISCOVERY_SECTIONS].map((entry) => {
    const label = normalizeSettingsQuery(entry.label);
    const words = normalizeSettingsQuery(`${entry.label} ${entry.aliases}`).split(" ");
    const matches = tokens.map((token) => words.some((word) => word === token || (stem(token).length >= 3 && stem(word).startsWith(stem(token)))));
    return { entry, score: matches.every(Boolean) ? (label === normalized ? 100 : label.includes(normalized) ? 60 : 20) + (entry.kind === "action" ? 5 : 0) : 0 };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).map((item) => item.entry);
  const settings = searchSettings(normalized).map((entry): DiscoveryEntry => ({
    id: `setting-${entry.id}`, kind: "action", sectionId: "settings", label: entry.label,
    description: "Открыть этот параметр в настройках.", aliases: entry.aliases,
    href: `/app/settings?section=${entry.section}&setting=${entry.id}`,
  }));
  return [...ranked, ...settings.filter((entry) => !ranked.some((item) => item.href === entry.href))];
}

export function currentDiscoverySection(pathname: string): AppNavRouteId | undefined {
  return DISCOVERY_SECTIONS.find((entry) => isAppRouteActive(pathname, entry.sectionId))?.sectionId;
}

export function guideHref(entry: DiscoveryEntry): string {
  const [path, query = ""] = entry.href.split("?");
  const params = new URLSearchParams(query);
  params.set("guide", entry.sectionId);
  return `${path}?${params}`;
}
