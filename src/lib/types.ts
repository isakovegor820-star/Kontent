// Доменная модель платформы. Соответствует ТЗ v2.0 (разделы 5, Приложение А).

export type Network = "tg" | "vk" | "youtube" | "instagram" | "x" | "tiktok" | "linkedin";

export type PostStatus =
  | "draft" // черновик
  | "queued" // в очереди без даты
  | "scheduled" // запланирован на дату/время
  | "publishing" // сервер публикует прямо сейчас
  | "published_unverified" // внешняя доставка не подтверждена
  | "published" // внешний id подтверждён
  | "missing" // Telegram подтвердил отсутствие сообщения
  | "deleted_external" // удалён во внешней сети
  | "failed_retry" // временный сбой, ждём server-side next_attempt_at
  | "quarantined" // дата истекла; нужна новая пользовательская revision
  | "cancelled" // пользователь отменил всю publication operation до provider-call
  | "failed"; // сбой (после 3 автоповторов)

export interface PostMetrics {
  views: number;
  reactions: number;
  comments: number;
  shares: number;
}

export interface Post {
  id: string;
  /** Владелец старой browser-only recovery-копии; отсутствие означает unowned legacy. */
  legacyOwnerUserId?: number;
  text: string;
  networks: Network[];
  /** ISO-строка. null — очередь без даты (ТЗ 5.3) */
  scheduledAt: string | null;
  status: PostStatus;
  /** Источник: откуда пост появился — важно для «связки разведка → контент» */
  origin: "manual" | "ai" | "trend" | "idea" | "competitor" | "rss" | "autopilot";
  /** Если пост родился из карточки тренда или залёта конкурента */
  sourceRef?: {
    kind: "trend" | "idea" | "reference" | "competitor" | "rss";
    id: string;
    label: string;
    /** Semantic intent is not factual evidence. */
    topic?: string;
    readerProblem?: string;
    semanticGoal?: string;
    /** Optional observed mechanics, especially for content_ideas. */
    hook?: string;
    structure?: string;
    whyItWorked?: string;
    /** Where an idea/reference came from; provenance does not authorize its claims. */
    provenance?: {
      kind: "content_idea" | "competitor_post" | "trend" | "radar_result" | "saved_reference" | "rss_item";
      id?: string;
      label?: string;
      url?: string;
    };
  };
  /**
   * В какой канал уходит пост. Нужен при нескольких подключённых каналах: без него
   * календарь показывает вперемешку посты разных каналов и выглядит как каша.
   * Для демо-постов пусто.
   */
  channelTitle?: string;
  /** id канала — устойчивый ключ для фильтра и оттенка аватарки (имя может меняться) */
  channelId?: number;
  /** Ссылка на вышедший пост в сети (t.me/… или vk.com/wall-…). Для демо-постов пусто. */
  postUrl?: string;
  /** Внешняя проверка: ссылка/метрики допустимы только для verified. */
  verificationState?: "unverified" | "verified" | "missing" | "unverifiable";
  /** Медиа поста. assetId/url появляются у реального результата ИИ-студии. */
  media?: {
    kind: "image" | "video";
    label: string;
    hue: number;
    assetId?: string;
    url?: string;
    mimeType?: string | null;
  } | null;
  metrics?: PostMetrics;
  /** Попытки публикации — сбой → 3 автоповтора (ТЗ 5.3) */
  attempts?: number;
  failReason?: string;
  createdAt: string;
}

export interface CompetitorPost {
  id: string;
  text: string;
  views: number;
  /** Во сколько раз выше медианы канала. ≥5 — «залёт» (ТЗ 5.5) */
  multiplier: number;
  format: string;
  topic: string;
  publishedAt: string;
}

export interface Competitor {
  id: string;
  name: string;
  handle: string;
  network: Network;
  avatarHue: number;
  subscribers: number;
  /** Прирост подписчиков за 30 дней, % */
  growth30d: number;
  /** Постов в неделю */
  postsPerWeek: number;
  /** Средний ER, % */
  er: number;
  medianViews: number;
  /** Признаки рекламы (ТЗ 5.4) */
  adSigns: number;
  /** Вывод ИИ в 2 предложениях — вверху досье (Приложение А, А7) */
  aiVerdict: string;
  topFormats: { name: string; share: number; er: number }[];
  topTopics: { name: string; share: number; lift: number }[];
  mentions: { source: string; tone: "pos" | "neu" | "neg"; text: string; date: string }[];
  bestPosts: CompetitorPost[];
  /** Динамика охвата за 12 недель */
  reachSeries: number[];
  addedAt: string;
  /** Статус сбора досье: добавил конкурента → через час досье (ТЗ Б4) */
  dossierStatus: "collecting" | "ready";
}

export interface Trend {
  id: string;
  title: string;
  /** Почему залетело — человеческим языком */
  why: string;
  /** Готовый сценарий для новой публикации */
  script: string[];
  scope: "niche" | "global";
  format: "video" | "post" | "carousel";
  /** Множитель: во сколько раз выше нормы */
  multiplier: number;
  /** Хук — первые 1-3 секунды видео (словарик ТЗ) */
  hook?: string;
  sourceCompetitorId?: string;
  sourceName?: string;
  detectedAt: string;
  hue: number;
}

export interface AutopilotSlot {
  id: string;
  /** 0 = понедельник */
  day: number;
  time: string;
  title: string;
  text: string;
  networks: Network[];
  origin: Post["origin"];
  sourceLabel?: string;
  status: "pending" | "approved" | "edited" | "rejected";
}

export interface Channel {
  id: string;
  network: Network;
  name: string;
  handle: string;
  subscribers: number;
  connected: boolean;
}

export interface Settings {
  /** Соло по умолчанию, команда — настройкой (ТЗ 5.10) */
  mode: "solo" | "team";
  /** Автопилот: подтверждать план или полное доверие (ТЗ 5.6) */
  autopilotConfirm: boolean;
  /** Тихие часы — не публиковать (Приложение А, А12) */
  quietHours: { from: string; to: string; enabled: boolean };
  botLinked: boolean;
  weeklyReport: boolean;
  /** Дневной лимит ИИ-генераций — честный, как требует ТЗ (раздел 12) */
  aiDailyLimit: number;
  aiUsedToday: number;
  niche: string;
  tone: string;
}

export interface User {
  id: number;
  name: string;
  email: string;
  provider: "email" | "google" | "vk" | "telegram";
  onboarded: boolean;
}

// --- Настоящие данные постинга (Д.3): каналы и посты из базы через API ---

export interface RealChannel {
  id: number;
  network: Network;
  title: string | null;
  handle: string | null;
  is_active: boolean;
  status?: "active" | "needs_reconnect" | "permission_lost" | "revoked" | "disconnected";
  last_auth_error_code?: string | null;
  last_auth_error_at?: string | null;
  reconnect_required?: boolean;
}

export interface RealPost {
  id: number;
  text: string;
  media: unknown;
  scheduled_at: string | null;
  status: PostStatus;
  tg_message_id: number | null;
  external_message_id: string | null;
  /** id вышедшей записи VK (для ссылки «Открыть пост») */
  vk_post_id: number | null;
  attempts: number;
  last_error: string | null;
  published_at: string | null;
  verification_state: "unverified" | "verified" | "missing" | "unverifiable";
  last_verification_attempt_at: string | null;
  last_verified_at: string | null;
  verification_error_code: string | null;
  verification_error_reason: string | null;
  publication_origin: Post["origin"] | "rss" | "retry" | "legacy";
  next_attempt_at: string | null;
  quarantined_at: string | null;
  quarantine_reason: string | null;
  schedule_revision: number;
  scheduled_timezone: string | null;
  scheduled_offset: string | null;
  scheduled_disambiguation: "reject" | "earlier" | "later" | null;
  publication_operation_id: number | null;
  publication_operation_status: string | null;
  operation_schedule_revision: number | null;
  created_at: string;
  network: Network;
  channel_title: string | null;
  channel_id: number | null;
  /** screen_name канала (для TG-ссылки t.me/<handle>/<id>) */
  handle: string | null;
  /** id VK-сообщества (для ссылки vk.com/wall-<gid>_<pid>) */
  vk_group_id: number | null;
  publication_parts: Array<{
    partIndex: number;
    type: "text" | "media" | "media_caption";
    externalMessageId: string | null;
    sendStatus: "pending" | "sending" | "sent" | "failed" | "unknown";
    verificationState: "unverified" | "verified" | "missing" | "unverifiable";
    lastErrorCode: string | null;
  }>;
}

export interface AppState {
  /** Кто вошёл — берётся с сервера (/api/auth/me), а не из localStorage (Д.2). */
  user: User | null;
  /** Прошёл ли мастер первого запуска. Локальный флаг (мастер — пока демо-шаг). */
  onboarded: boolean;
  channels: Channel[];
  posts: Post[];
  competitors: Competitor[];
  trends: Trend[];
  autopilot: AutopilotSlot[];
  settings: Settings;
  /** Заявки в лист ожидания с лендинга — виден владельцу (ТЗ 8.2) */
  waitlist: { contact: string; at: string }[];
}
