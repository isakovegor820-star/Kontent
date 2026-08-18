export type TodayDraft = Readonly<{
  id: number;
  text: string;
  purpose: "source_context" | "publishable" | "needs_review";
  editorial_state?: "draft" | "in_review" | "changes_requested" | "approved";
  scheduled_at: string | null;
  updated_at: string;
}>;

export type TodayInquiry = Readonly<{
  id: number;
  authorName: string | null;
  incomingText: string;
  status: "pending" | "reply_ready" | "approved" | "sent" | "dismissed" | "failed";
  riskLevel: "low" | "medium" | "high" | null;
  createdAt: string;
}>;

export type TodayAudienceStats = Readonly<{
  waiting: number;
  ready: number;
  highRisk: number;
}>;

export type TodayQuestion = Readonly<{
  id: number;
  question: string;
  priority: 1 | 2 | 3;
  occurrences: number;
  status: "new" | "drafting" | "planned" | "answered" | "dismissed";
  updatedAt: string;
}>;

export type TodaySnapshot = Readonly<{
  drafts: readonly TodayDraft[] | null;
  audience: Readonly<{
    inquiries: readonly TodayInquiry[];
    stats: TodayAudienceStats;
  }> | null;
  questions: readonly TodayQuestion[] | null;
  rssUnreadCount: number | null;
}>;

export type TodayTaskKind =
  | "changes_requested"
  | "high_risk_reply"
  | "ready_reply"
  | "waiting_reply"
  | "audience_question"
  | "unscheduled_draft"
  | "rss";

export type TodayTask = Readonly<{
  id: string;
  kind: TodayTaskKind;
  label: string;
  title: string;
  description: string;
  href: string;
  actionLabel: string;
  score: number;
}>;

export type TodayMetric = Readonly<{
  id: "audience" | "drafts" | "opportunities";
  label: string;
  value: number | null;
  href: string;
}>;

export type TodayView = Readonly<{
  tasks: readonly TodayTask[];
  metrics: readonly TodayMetric[];
}>;

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function newest<T>(items: readonly T[], date: (item: T) => string): T | null {
  return [...items].sort((left, right) => {
    const leftTime = Date.parse(date(left));
    const rightTime = Date.parse(date(right));
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
  })[0] ?? null;
}

function excerpt(value: string, max = 112): string {
  const clean = value.replace(/\s+/gu, " ").trim();
  if (!clean) return "Материал без заголовка";
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function countPhrase(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word = mod10 === 1 && mod100 !== 11
    ? one
    : mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)
      ? few
      : many;
  return `${count} ${word}`;
}

function activeInquiry(inquiry: TodayInquiry): boolean {
  return ["pending", "failed", "reply_ready", "approved"].includes(inquiry.status);
}

export function buildTodayView(snapshot: TodaySnapshot, limit = 3): TodayView {
  const tasks: TodayTask[] = [];
  const drafts = snapshot.drafts ?? [];
  const questions = snapshot.questions ?? [];
  const inquiries = snapshot.audience?.inquiries ?? [];

  const changesRequested = drafts.filter((draft) => draft.editorial_state === "changes_requested");
  const latestChanges = newest(changesRequested, (draft) => draft.updated_at);
  if (latestChanges) {
    tasks.push({
      id: `changes-requested-${latestChanges.id}`,
      kind: "changes_requested",
      label: "Согласование",
      title: changesRequested.length === 1
        ? "Внести правки в материал"
        : `Исправить ${countPhrase(changesRequested.length, "материал", "материала", "материалов")}`,
      description: `«${excerpt(latestChanges.text)}» вернули с замечаниями.`,
      href: `/app/composer?draft=${latestChanges.id}`,
      actionLabel: "Открыть замечания",
      score: 100,
    });
  }

  const highRisk = inquiries.filter((inquiry) => activeInquiry(inquiry) && inquiry.riskLevel === "high");
  const latestHighRisk = newest(highRisk, (inquiry) => inquiry.createdAt);
  if (latestHighRisk) {
    const source = latestHighRisk.authorName?.trim()
      ? `Сообщение автора «${latestHighRisk.authorName.trim()}»`
      : "Сообщение аудитории";
    tasks.push({
      id: `high-risk-${latestHighRisk.id}`,
      kind: "high_risk_reply",
      label: "Требует внимания",
      title: highRisk.length === 1 ? "Проверить сложный ответ" : "Проверить сложные ответы",
      description: `${source} отмечено как чувствительное. Проверьте тон перед отправкой.`,
      href: `/app/studio/questions?inquiry=${latestHighRisk.id}`,
      actionLabel: "Проверить ответ",
      score: 95,
    });
  }

  const readyReplies = inquiries.filter((inquiry) => (
    (inquiry.status === "reply_ready" || inquiry.status === "approved") && inquiry.riskLevel !== "high"
  ));
  if (readyReplies.length > 0) {
    tasks.push({
      id: "ready-replies",
      kind: "ready_reply",
      label: "Ответы аудитории",
      title: readyReplies.length === 1 ? "Отправить готовый ответ" : "Отправить готовые ответы",
      description: `Аврора подготовила ${countPhrase(readyReplies.length, "ответ", "ответа", "ответов")} — осталось проверить и отправить.`,
      href: "/app/studio/questions",
      actionLabel: "Открыть ответы",
      score: 85,
    });
  }

  const topQuestion = [...questions]
    .filter((question) => question.status === "new")
    .sort((left, right) => (
      right.priority - left.priority
      || right.occurrences - left.occurrences
      || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    ))[0];
  if (topQuestion) {
    const demand = topQuestion.occurrences > 1
      ? `Его задали ${countPhrase(topQuestion.occurrences, "раз", "раза", "раз")}.`
      : "Это новый вопрос аудитории.";
    tasks.push({
      id: `audience-question-${topQuestion.id}`,
      kind: "audience_question",
      label: "Идея из спроса",
      title: "Сделать пост по вопросу аудитории",
      description: `«${excerpt(topQuestion.question)}» ${demand}`,
      href: `/app/studio?audienceQuestion=${topQuestion.id}`,
      actionLabel: "Создать пост",
      score: 75 + topQuestion.priority,
    });
  }

  const waitingReplies = inquiries.filter((inquiry) => (
    (inquiry.status === "pending" || inquiry.status === "failed") && inquiry.riskLevel !== "high"
  ));
  if (waitingReplies.length > 0) {
    tasks.push({
      id: "waiting-replies",
      kind: "waiting_reply",
      label: "Ответы аудитории",
      title: waitingReplies.length === 1 ? "Ответить на новое сообщение" : "Ответить на новые сообщения",
      description: `${countPhrase(waitingReplies.length, "сообщение ждёт", "сообщения ждут", "сообщений ждут")} ответа.`,
      href: "/app/studio/questions",
      actionLabel: "Подготовить ответы",
      score: 70,
    });
  }

  const unscheduled = drafts.filter((draft) => (
    draft.purpose === "publishable"
    && draft.scheduled_at == null
    && draft.editorial_state !== "in_review"
    && draft.editorial_state !== "changes_requested"
  ));
  const latestUnscheduled = newest(unscheduled, (draft) => draft.updated_at);
  if (latestUnscheduled) {
    tasks.push({
      id: `unscheduled-${latestUnscheduled.id}`,
      kind: "unscheduled_draft",
      label: "Контент-план",
      title: unscheduled.length === 1 ? "Поставить черновик в календарь" : "Запланировать готовые черновики",
      description: `«${excerpt(latestUnscheduled.text)}» пока без даты публикации.`,
      href: `/app/composer?draft=${latestUnscheduled.id}`,
      actionLabel: "Запланировать",
      score: 60,
    });
  }

  const metricOpportunities = snapshot.rssUnreadCount == null
    ? null
    : safeCount(snapshot.rssUnreadCount);
  const unread = metricOpportunities ?? 0;
  if (unread > 0) {
    tasks.push({
      id: "rss-opportunities",
      kind: "rss",
      label: "Инфоповоды",
      title: unread === 1 ? "Проверить свежий инфоповод" : "Выбрать свежий инфоповод",
      description: `${countPhrase(unread, "новый материал подходит", "новых материала подходят", "новых материалов подходят")} для публикаций.`,
      href: "/app/rss",
      actionLabel: "Посмотреть материалы",
      score: 40,
    });
  }

  const metricAudience = snapshot.audience
    ? safeCount(snapshot.audience.stats.waiting) + safeCount(snapshot.audience.stats.ready)
    : null;
  const metricDrafts = snapshot.drafts == null ? null : unscheduled.length + changesRequested.length;

  return {
    tasks: tasks
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, Math.max(0, limit)),
    metrics: [
      { id: "audience", label: "Ответы аудитории", value: metricAudience, href: "/app/studio/questions" },
      { id: "drafts", label: "Черновики требуют шага", value: metricDrafts, href: "/app/calendar" },
      { id: "opportunities", label: "Новые инфоповоды", value: metricOpportunities, href: "/app/rss" },
    ],
  };
}
