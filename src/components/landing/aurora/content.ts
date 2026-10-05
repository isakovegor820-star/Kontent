import type { LucideIcon } from "lucide-react";
import {
  BookOpenCheck,
  CalendarDays,
  ClipboardCheck,
  Clock3,
  Download,
  FileCheck2,
  Globe,
  History,
  PenLine,
  Scale,
  Send,
  ShieldCheck,
  UsersRound,
} from "lucide-react";

/**
 * Подписи к сценам и плиткам главной.
 *
 * Всё, что описывает продукт словами (ответ, кому подходит, вопросы, цена, дата),
 * живёт в `lib/product`, `lib/seo/faq`, `lib/author`, `lib/pricing` — здесь только
 * тексты самих плиток, у которых нет другого дома. Один источник правды о продукте
 * не размножается по компонентам.
 */

/** Размер плитки в bento-сетке: 12 колонок, как в макете. */
export type Span = 3 | 4 | 5 | 6 | 7 | 8 | 12;

/** Тон плитки: цвет и смысл связаны — «действие» градиентное, «состояние» пастельное. */
export type Tone =
  | "cInk"
  | "cGrape"
  | "cBlue"
  | "cTeal"
  | "cRed"
  | "cSun"
  | "cLime"
  | "cMint"
  | "cSky"
  | "cPeach"
  | "cPaper"
  | "cPearl";

/* --------------------------------------------------- ПЕРВЫЙ ЭКРАН: МОЗАИКА */

export type HeroTile = {
  readonly id: string;
  readonly tone: Tone;
  readonly span: Span;
  readonly tall?: boolean;
  readonly icon?: LucideIcon;
  readonly title: string;
  readonly text?: string;
  readonly tag?: string;
};

/**
 * Пять плиток первого экрана складываются в мозаику без пустых ячеек:
 *   [план 5×2][доказательства 4][риск 3]
 *   [план  … ][версии 3][Telegram 4]
 */
export const HERO_TILES: readonly HeroTile[] = Object.freeze([
  {
    id: "plan",
    tone: "cGrape",
    span: 5,
    tall: true,
    icon: CalendarDays,
    title: "Контент-план недели",
    text: "Темы, даты и ответственные — на одном экране, без таблиц.",
    tag: "Пример недели · так выглядит план",
  },
  {
    id: "evidence",
    tone: "cSun",
    span: 4,
    icon: BookOpenCheck,
    title: "Доказательства рядом с утверждением",
  },
  {
    id: "risk",
    tone: "cMint",
    span: 3,
    title: "Риск отмечен до публикации",
    tag: "Конфликтную формулировку видно заранее",
  },
  {
    id: "versions",
    tone: "cInk",
    span: 3,
    icon: History,
    title: "История версий",
    text: "Каждое решение привязано к своей версии.",
  },
  {
    id: "telegram",
    tone: "cBlue",
    span: 4,
    icon: Send,
    title: "Публикация в Telegram",
    text: "Расписание, статусы и повтор попытки без дублей.",
    tag: "Канал публикуется по расписанию",
  },
] as const);

/**
 * Дни недели в плитке плана.
 *
 * Плитка высокая (две полосы сетки), поэтому день — не плоский чип, а колонка
 * недельного плана: дата, карточка будущего поста и статус. `lines` — длины строк
 * карточки в процентах: так текст поста читается как текст, а не как рыба.
 * Пустой день нарисован пунктиром: видно, куда встанет следующий материал.
 */
export type HeroWeekDay = {
  readonly day: string;
  readonly date: string;
  readonly status: string;
  readonly tone: string;
  readonly state: "done" | "planned" | "empty" | "draft";
  readonly lines: readonly number[];
};

export const HERO_WEEK: readonly HeroWeekDay[] = Object.freeze([
  { day: "Пн", date: "12", status: "Готово", tone: "mB", state: "done", lines: [100, 78, 52] },
  { day: "Вт", date: "13", status: "10:00", tone: "mV", state: "planned", lines: [100, 64] },
  { day: "Ср", date: "14", status: "Пауза", tone: "", state: "empty", lines: [] },
  { day: "Чт", date: "15", status: "18:30", tone: "mC", state: "planned", lines: [100, 84, 58] },
  { day: "Пт", date: "16", status: "Идея", tone: "mO", state: "draft", lines: [100] },
]);

/**
 * Итог недели под полосой дней. Числа сходятся с тем, что видно выше:
 * материалы стоят в трёх днях, один день занят идеей, один свободен.
 * Держим их числами, а не строками: «4 из 5» и «80%» досчитываются в интерфейсе.
 */
export const HERO_WEEK_SUMMARY = Object.freeze({
  filled: 4,
  total: 5,
  percent: 80,
});

/** Контрольные точки доказательства в плитке первого экрана. */
export const HERO_EVIDENCE_CHECKS = Object.freeze([
  "Источник указан",
  "Дата актуальности есть",
  "Решение — ожидается",
] as const);

/* ---------------------------------------------------------- ВОЗМОЖНОСТИ */

export type Feature = {
  readonly tone: Tone;
  readonly icon: LucideIcon;
  readonly title: string;
  readonly text: string;
};

export const FEATURES: readonly Feature[] = Object.freeze([
  {
    tone: "cBlue",
    icon: PenLine,
    title: "Планирование публикаций",
    text: "Собирайте контент-план, готовьте материалы и назначайте время публикации в Telegram.",
  },
  {
    tone: "cSun",
    icon: CalendarDays,
    title: "Единый календарь",
    text: "Проверяйте всю неделю, находите пробелы и переносите материалы без ручных таблиц.",
  },
  {
    tone: "cMint",
    icon: BookOpenCheck,
    title: "Факты и доказательства",
    text: "Добавляйте к утверждениям источник, дату актуальности и правила использования.",
  },
  {
    tone: "cGrape",
    icon: UsersRound,
    title: "Командная работа",
    text: "Роли, версии, комментарии и решения остаются рядом с материалом.",
  },
  {
    tone: "cSky",
    icon: ClipboardCheck,
    title: "Редакционное согласование",
    text: "Отправляйте точную версию на проверку и сохраняйте историю решений.",
  },
  {
    tone: "cRed",
    icon: ShieldCheck,
    title: "Контроль перед публикацией",
    text: "Аврора отмечает конфликтные настройки, а финальное решение принимает юрист.",
  },
] as const);

/* --------------------------------------------------------------- ПРОЦЕСС */

export type Step = {
  readonly index: string;
  readonly tone: Tone;
  readonly title: string;
  readonly text: string;
  /** Короткий результат шага. Строки проверяются тестом главной страницы. */
  readonly result: string;
};

export const STEPS: readonly Step[] = Object.freeze([
  {
    index: "01",
    tone: "cBlue",
    title: "Настройте проект",
    text: "Добавьте данные о практике, аудитории и правилах юридического контента.",
    result: "Контекст собран",
  },
  {
    index: "02",
    tone: "cLime",
    title: "Соберите контент-план",
    text: "Разложите темы по датам и подготовьте отдельные редактируемые материалы.",
    result: "План готов",
  },
  {
    index: "03",
    tone: "cGrape",
    title: "Привяжите доказательства",
    text: "Укажите источник, актуальность и допустимую формулировку для значимых фактов.",
    result: "Источники связаны",
  },
  {
    index: "04",
    tone: "cTeal",
    title: "Согласуйте и опубликуйте",
    text: "Подтвердите версию и отправьте её в Telegram. VK доступен после настройки интеграции.",
    result: "Версия согласована",
  },
] as const);

/* -------------------------------------------------------------- СТАНДАРТ */

export type StandardRule = {
  readonly id: string;
  readonly tone: Tone;
  readonly span: Span;
  readonly icon?: LucideIcon;
  readonly title: string;
  /** Не у каждой плитки есть описание: у печати с крупным знаком его заменяет подпись. */
  readonly text?: string;
  readonly checks?: readonly string[];
  readonly tag?: string;
  /** Плитка-печать с крупным знаком вместо иконки. */
  readonly big?: string;
  readonly bigLabel?: string;
};

export const STANDARD_RULES: readonly StandardRule[] = Object.freeze([
  {
    id: "source",
    tone: "cGrape",
    span: 5,
    icon: BookOpenCheck,
    title: "Проверяемость вместо обещаний",
    text: "К каждому значимому утверждению привязана основа, а не общее заверение.",
    checks: [
      "Источник указан и открывается",
      "Дата актуальности зафиксирована",
      "Правила использования учтены",
    ],
  },
  {
    id: "fact",
    tone: "cSun",
    span: 4,
    icon: ShieldCheck,
    title: "Ни один значимый факт — без источника",
    text: "Утверждение без источника нельзя перевести в статус «согласовано».",
    tag: "Правило действует всегда",
  },
  {
    id: "risk",
    tone: "cMint",
    span: 3,
    big: "✓",
    title: "Риск виден до публикации",
    tag: "Конфликтную формулировку показываем заранее",
  },
  {
    id: "human",
    tone: "cInk",
    span: 4,
    icon: UsersRound,
    title: "Решение принимает человек",
    text: "Полный автомат сервер отклоняет — включить его нельзя. Финальное слово за юристом.",
  },
  {
    id: "status",
    tone: "cPeach",
    span: 4,
    icon: Clock3,
    title: "Прозрачные статусы",
    text: "Видно, что в черновике, что на проверке, что согласовано, а что уже опубликовано.",
  },
  {
    id: "export",
    tone: "cBlue",
    span: 4,
    icon: Download,
    title: "Выгрузка без замка",
    text: "Материалы, версии и отчёты выгружаются: данные не запираются внутри сервиса.",
  },
] as const);

/* ----------------------------------------------------------- ДОКАЗАТЕЛЬСТВА */

export type CapabilityScene = "evidence" | "sources" | "history";

export type Capability = {
  readonly tone: Tone;
  readonly icon: LucideIcon;
  readonly scene: CapabilityScene;
  readonly title: string;
  readonly text: string;
};

export const CAPABILITIES: readonly Capability[] = Object.freeze([
  {
    tone: "cSun",
    icon: FileCheck2,
    scene: "evidence",
    title: "Карточка доказательства",
    text: "Тип, содержание, источник и дата актуальности хранятся вместе с настройками материала.",
  },
  {
    tone: "cSky",
    icon: Scale,
    scene: "sources",
    title: "Юридические источники",
    text: "Публичные ленты и разрешённые подключения отделены от закрытых и неподтверждённых данных.",
  },
  {
    tone: "cGrape",
    icon: History,
    scene: "history",
    title: "История согласования",
    text: "Комментарии и решения относятся к конкретной версии и не теряются после правок.",
  },
] as const);

/* ------------------------------------------------------------ ИНТЕГРАЦИИ */

export type Integration = {
  readonly id: string;
  readonly tone: Tone;
  readonly icon: LucideIcon;
  readonly title: string;
  readonly text: string;
  readonly status: string;
  readonly statusTone: "live" | "setup" | "planned";
};

export const INTEGRATIONS: readonly Integration[] = Object.freeze([
  {
    id: "telegram",
    tone: "cSky",
    icon: Send,
    title: "Telegram",
    text: "Подключение канала, расписание и серверная публикация.",
    status: "работает",
    statusTone: "live",
  },
  {
    id: "vk",
    tone: "cBlue",
    icon: UsersRound,
    title: "ВКонтакте",
    text: "После настройки приложения и тестового сообщества.",
    status: "после настройки",
    statusTone: "setup",
  },
  {
    id: "other",
    tone: "cPearl",
    icon: Globe,
    title: "Другие сети",
    text: "Пока не заявлены как подключённые — Аврора не имитирует каналы, которых нет.",
    status: "не заявлены",
    statusTone: "planned",
  },
] as const);

/* ----------------------------------------------------------------- ДОСТУП */

export type AccessTone = "editor" | "telegram" | "vk";

export type AccessCard = {
  /** Семантический ключ контура: по нему карточку находят тест и инструменты. */
  readonly tone: AccessTone;
  /** Цвет плитки. Телеграм и ВК носят те же тона, что в секции каналов. */
  readonly color: Tone;
  readonly icon: LucideIcon;
  readonly title: string;
  readonly note: string;
  readonly features: readonly string[];
  readonly status: string;
  readonly state: "live" | "setup";
};

export const ACCESS_CARDS: readonly AccessCard[] = Object.freeze([
  {
    tone: "editor",
    color: "cGrape",
    icon: CalendarDays,
    title: "Редактор и контент-план",
    note: "Основной рабочий контур для подготовки юридического контента.",
    features: [
      "Черновики и календарь",
      "Источники и доказательства",
      "Настройки тона, включая необязательный мат",
    ],
    status: "Доступно",
    state: "live",
  },
  {
    tone: "telegram",
    color: "cSky",
    icon: Send,
    title: "Telegram",
    note: "Подключение канала, расписание и серверная публикация.",
    features: [
      "Публикация по расписанию",
      "Статусы и история операций",
      "Повторная попытка без дублей",
    ],
    status: "Доступно",
    state: "live",
  },
  {
    tone: "vk",
    color: "cBlue",
    icon: UsersRound,
    title: "ВКонтакте",
    note: "Зависит от настроенного приложения и тестового сообщества.",
    features: [
      "Подключение сообщества",
      "Проверка разрешений",
      "Статус готовности внутри проекта",
    ],
    status: "После настройки",
    state: "setup",
  },
] as const);
