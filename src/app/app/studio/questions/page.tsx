"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowUpRight,
  CheckCircle2,
  CircleHelp,
  Clock3,
  FileText,
  MessageCircleQuestion,
  Plus,
  RotateCcw,
  Sparkles,
} from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { Button, buttonClassName } from "@/components/ui/button";
import { Badge, Card, Field, Input, Textarea } from "@/components/ui/primitives";
import type {
  AudienceQuestionPriority,
  AudienceQuestionRecord,
  AudienceQuestionSource,
  AudienceQuestionStats,
  AudienceQuestionStatus,
} from "@/lib/audience-questions";
import { cn } from "@/lib/utils";

type View = "waiting" | "progress" | "closed";
type ApiError = { error?: string; requestId?: string };

const SOURCE_LABELS: Record<AudienceQuestionSource, string> = {
  manual: "Добавлено вручную",
  comment: "Комментарий",
  direct_message: "Личное сообщение",
  support: "Поддержка",
  sales: "Отдел продаж",
  search: "Поисковый запрос",
  other: "Другой источник",
};

const PRIORITY_LABELS: Record<AudienceQuestionPriority, string> = {
  1: "Можно позже",
  2: "Обычный",
  3: "Важно",
};

const STATUS_LABELS: Record<AudienceQuestionStatus, string> = {
  new: "Ждёт ответа",
  drafting: "Аврора готовит пост",
  planned: "Черновик создан",
  answered: "Ответ опубликован",
  dismissed: "Убрано из очереди",
};

const EMPTY_STATS: AudienceQuestionStats = {
  waiting: 0,
  inProgress: 0,
  answered: 0,
  dismissed: 0,
  repeatedDemand: 0,
};

const SELECT_CLASS = cn(
  "type-input h-12 w-full rounded-xs border border-line bg-surface px-4 text-text",
  "transition-colors hover:border-line-strong focus:border-brand focus:outline-none",
  "focus-visible:ring-4 focus-visible:ring-brand/15",
);

function questionError(error: string | undefined) {
  if (error === "version_conflict") return "Вопрос изменился в другой вкладке. Обновите список и повторите действие.";
  if (error === "invalid_status") return "Для вопроса уже создан материал. Обновите список и откройте черновик.";
  if (error === "draft_not_found") return "Связанный черновик не найден в выбранном проекте.";
  if (error === "access_denied") return "Недостаточно прав для изменения вопросов этого проекта.";
  if (error === "payload_too_large") return "Сократите вопрос или контекст и повторите.";
  if (error === "invalid_request" || error === "bad_request") return "Проверьте заполненные поля и повторите.";
  return "Не удалось выполнить действие. Проверьте соединение и повторите.";
}

function relativeDate(value: string) {
  const date = new Date(value);
  const today = new Date();
  const days = Math.floor((today.getTime() - date.getTime()) / 86_400_000);
  if (days <= 0) return "сегодня";
  if (days === 1) return "вчера";
  if (days < 7) return `${days} дн. назад`;
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" }).format(date);
}

function occurrencesLabel(value: number) {
  const mod10 = value % 10;
  const mod100 = value % 100;
  const noun = mod10 === 1 && mod100 !== 11 ? "раз"
    : mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14) ? "раза"
      : "раз";
  return `Спросили ${value} ${noun}`;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json().catch(() => null) as (T & ApiError) | null;
  if (!response.ok || !body) {
    const error = new Error(questionError(body?.error));
    (error as Error & { code?: string }).code = body?.error;
    throw error;
  }
  return body;
}

function StatCard({ icon, label, value, hint }: {
  icon: React.ReactNode;
  label: string;
  value: number;
  hint: string;
}) {
  return (
    <Card className="min-w-0 p-4 md:p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="type-label text-text-3">{label}</p>
          <p className="mt-2 text-3xl font-bold tracking-tight text-text tabular-nums">{value}</p>
        </div>
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm bg-info-soft text-brand" aria-hidden>
          {icon}
        </span>
      </div>
      <p className="type-caption mt-3 text-pretty text-text-3">{hint}</p>
    </Card>
  );
}

function QuestionCard({
  question,
  busy,
  onStart,
  onUpdate,
}: {
  question: AudienceQuestionRecord;
  busy: boolean;
  onStart: (question: AudienceQuestionRecord) => void;
  onUpdate: (question: AudienceQuestionRecord, status: AudienceQuestionStatus) => void;
}) {
  return (
    <Card as="article" className="p-5 md:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={question.status === "answered" ? "success" : "neutral"}>
              {STATUS_LABELS[question.status]}
            </Badge>
            {question.priority === 3 && <Badge tone="fire">Важно</Badge>}
            <span className="type-caption text-text-3">{SOURCE_LABELS[question.sourceType]}</span>
            <span aria-hidden className="text-text-3/50">·</span>
            <span className="type-caption text-text-3">{relativeDate(question.lastSeenAt)}</span>
          </div>
          <h2 className="mt-3 max-w-[72ch] text-balance text-xl font-bold leading-snug text-text">
            {question.question}
          </h2>
          {question.context && (
            <p className="mt-2 max-w-[75ch] text-pretty text-[14px] leading-relaxed text-text-2">
              {question.context}
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-text-3">
            <span className="inline-flex items-center gap-1.5 font-semibold text-text-2">
              <MessageCircleQuestion className="h-4 w-4 text-brand" aria-hidden />
              {occurrencesLabel(question.occurrences)}
            </span>
            {question.topic && <span>Тема: {question.topic}</span>}
            {question.sourceLabel && <span>Источник: {question.sourceLabel}</span>}
            {question.sourceUrl && (
              <a
                href={question.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 items-center gap-1 font-semibold text-brand underline decoration-brand/30 underline-offset-4 hover:decoration-brand"
              >
                Открыть источник <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
              </a>
            )}
          </div>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {question.status === "new" && (
          <Button variant="primary" loading={busy} onClick={() => onStart(question)}>
            {!busy && <Sparkles className="h-4 w-4" aria-hidden />}
            Создать ответ
          </Button>
        )}
        {question.status === "drafting" && (
          <Button variant="primary" onClick={() => onStart(question)}>
            <Sparkles className="h-4 w-4" aria-hidden />
            Продолжить создание
          </Button>
        )}
        {question.status === "planned" && question.answerDraftId && (
          <Link
            href={`/app/composer?draft=${question.answerDraftId}&from=studio`}
            className={buttonClassName({ variant: "primary" })}
          >
            <FileText className="h-4 w-4" aria-hidden />
            Открыть черновик
          </Link>
        )}
        {question.status === "planned" && (
          <Button variant="secondary" loading={busy} onClick={() => onUpdate(question, "answered")}>
            {!busy && <CheckCircle2 className="h-4 w-4" aria-hidden />}
            Отметить отвеченным
          </Button>
        )}
        {question.status === "new" && (
          <Button variant="ghost" loading={busy} onClick={() => onUpdate(question, "dismissed")}>
            {!busy && <Archive className="h-4 w-4" aria-hidden />}
            Убрать из очереди
          </Button>
        )}
        {(question.status === "answered" || question.status === "dismissed") && (
          <Button variant="secondary" loading={busy} onClick={() => onUpdate(question, "new")}>
            {!busy && <RotateCcw className="h-4 w-4" aria-hidden />}
            Вернуть в работу
          </Button>
        )}
      </div>
    </Card>
  );
}

export default function AudienceQuestionsPage() {
  const router = useRouter();
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const formErrorRef = useRef<HTMLParagraphElement>(null);
  const [questions, setQuestions] = useState<AudienceQuestionRecord[]>([]);
  const [stats, setStats] = useState<AudienceQuestionStats>(EMPTY_STATS);
  const [view, setView] = useState<View>("waiting");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [busyId, setBusyId] = useState<number | "create" | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [formError, setFormError] = useState("");
  const [questionFieldError, setQuestionFieldError] = useState("");
  const [occurrencesError, setOccurrencesError] = useState("");
  const [sourceUrlError, setSourceUrlError] = useState("");
  const [question, setQuestion] = useState("");
  const [topic, setTopic] = useState("");
  const [priority, setPriority] = useState<AudienceQuestionPriority>(2);
  const [occurrences, setOccurrences] = useState("1");
  const [sourceType, setSourceType] = useState<AudienceQuestionSource>("manual");
  const [sourceLabel, setSourceLabel] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [context, setContext] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const result = await json<{ questions: AudienceQuestionRecord[]; stats: AudienceQuestionStats }>(
        "/api/audience-questions",
      );
      setQuestions(result.questions);
      setStats(result.stats);
    } catch (error) {
      setLoadError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (formError) formErrorRef.current?.focus();
  }, [formError]);

  const visible = useMemo(() => questions.filter((item) => {
    if (view === "waiting") return item.status === "new";
    if (view === "progress") return item.status === "drafting" || item.status === "planned";
    return item.status === "answered" || item.status === "dismissed";
  }), [questions, view]);

  const replaceQuestion = (next: AudienceQuestionRecord) => {
    setQuestions((current) => {
      const exists = current.some((item) => item.id === next.id);
      return exists ? current.map((item) => item.id === next.id ? next : item) : [next, ...current];
    });
  };

  const refreshStats = () => void load();

  const createQuestion = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError("");
    setQuestionFieldError("");
    setOccurrencesError("");
    setSourceUrlError("");
    setStatusMessage("");
    if (question.trim().length < 3) {
      setQuestionFieldError("Запишите вопрос хотя бы тремя символами.");
      questionRef.current?.focus();
      return;
    }
    const occurrenceCount = Number(occurrences);
    if (!Number.isInteger(occurrenceCount) || occurrenceCount < 1 || occurrenceCount > 10_000) {
      setOccurrencesError("Укажите целое число от 1 до 10 000.");
      document.getElementById("audience-occurrences")?.focus();
      return;
    }
    if (sourceUrl.trim()) {
      try {
        if (new URL(sourceUrl.trim()).protocol !== "https:") throw new Error("protocol");
      } catch {
        setSourceUrlError("Введите полную защищённую ссылку, которая начинается с https://");
        document.getElementById("audience-source-url")?.focus();
        return;
      }
    }
    setBusyId("create");
    try {
      const result = await json<{ question: AudienceQuestionRecord; duplicate: boolean }>(
        "/api/audience-questions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requestKey: crypto.randomUUID(),
            question,
            topic: topic || null,
            priority,
            occurrences: occurrenceCount,
            sourceType,
            sourceLabel: sourceLabel || null,
            sourceUrl: sourceUrl || null,
            context: context || null,
          }),
        },
      );
      replaceQuestion(result.question);
      setQuestion("");
      setTopic("");
      setOccurrences("1");
      setSourceLabel("");
      setSourceUrl("");
      setContext("");
      setStatusMessage(result.duplicate
        ? "Этот запрос уже сохранён. Частота вопроса обновлена."
        : "Вопрос добавлен в редакционную очередь.");
      setView("waiting");
      refreshStats();
      questionRef.current?.focus();
    } catch (error) {
      setFormError((error as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const start = async (item: AudienceQuestionRecord) => {
    if (item.status === "drafting") {
      router.push(`/app/studio?audienceQuestion=${item.id}&intent=create`);
      return;
    }
    setBusyId(item.id);
    setLoadError("");
    try {
      const result = await json<{ question: AudienceQuestionRecord }>(
        `/api/audience-questions/${item.id}/start`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedVersion: item.version }),
        },
      );
      replaceQuestion(result.question);
      router.push(`/app/studio?audienceQuestion=${item.id}&intent=create`);
    } catch (error) {
      setLoadError((error as Error).message);
      setBusyId(null);
    }
  };

  const update = async (item: AudienceQuestionRecord, status: AudienceQuestionStatus) => {
    setBusyId(item.id);
    setLoadError("");
    try {
      const result = await json<{ question: AudienceQuestionRecord }>(
        `/api/audience-questions/${item.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedVersion: item.version, status }),
        },
      );
      replaceQuestion(result.question);
      setStatusMessage(status === "answered" ? "Вопрос отмечен отвеченным." : status === "new" ? "Вопрос возвращён в работу." : "Вопрос убран из очереди.");
      refreshStats();
    } catch (error) {
      setLoadError((error as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <AppShell
      title="Запросы аудитории"
      subtitle="Собирайте реальные вопросы и превращайте их в публикации, которые уже ждут."
    >
      <div className="mx-auto w-full max-w-[1450px] space-y-6">
        <section aria-label="Состояние запросов" className="grid gap-3 min-[360px]:grid-cols-2 xl:grid-cols-4">
          <StatCard icon={<CircleHelp className="h-5 w-5" />} label="Ждут ответа" value={stats.waiting} hint="Вопросы, для которых ещё нет материала" />
          <StatCard icon={<Clock3 className="h-5 w-5" />} label="В работе" value={stats.inProgress} hint="Аврора готовит пост или черновик уже создан" />
          <StatCard icon={<CheckCircle2 className="h-5 w-5" />} label="Закрыто" value={stats.answered} hint="Вопросы, на которые канал уже ответил" />
          <StatCard icon={<MessageCircleQuestion className="h-5 w-5" />} label="Повторный спрос" value={stats.repeatedDemand} hint="Сколько раз вопросы задавали повторно" />
        </section>

        {(loadError || statusMessage) && (
          <div
            role={loadError ? "alert" : "status"}
            aria-live="polite"
            className={cn(
              "rounded-sm px-4 py-3 text-[14px] font-semibold",
              loadError ? "bg-danger-soft text-danger-text" : "bg-success-soft text-success-text",
            )}
          >
            {loadError || statusMessage}
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
          <section aria-labelledby="question-queue-heading" className="min-w-0 space-y-4">
            <div>
              <div>
                <h2 id="question-queue-heading" className="text-2xl font-bold tracking-tight text-text">Редакционная очередь</h2>
                <p className="mt-1 max-w-[65ch] text-pretty text-[14px] leading-relaxed text-text-3">
                  Частые и важные вопросы поднимаются выше. Один вопрос превращается в один отслеживаемый ответ.
                </p>
              </div>
              <div className="mt-4 flex flex-wrap gap-2" aria-label="Фильтр вопросов">
                {([
                  ["waiting", `Ждут ответа · ${stats.waiting}`],
                  ["progress", `В работе · ${stats.inProgress}`],
                  ["closed", `Закрытые · ${stats.answered + stats.dismissed}`],
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={view === value}
                    onClick={() => setView(value)}
                    className={cn(
                      "min-h-11 rounded-xs px-3.5 py-2 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15",
                      view === value ? "bg-brand text-white" : "bg-surface text-text-2 hover:bg-surface-inset hover:text-text",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {loading ? (
              <Card className="flex min-h-72 items-center justify-center p-8">
                <p role="status" className="text-[14px] text-text-3">Загружаем вопросы…</p>
              </Card>
            ) : visible.length > 0 ? (
              <div className="space-y-3">
                {visible.map((item) => (
                  <QuestionCard
                    key={item.id}
                    question={item}
                    busy={busyId === item.id}
                    onStart={(next) => void start(next)}
                    onUpdate={(next, status) => void update(next, status)}
                  />
                ))}
              </div>
            ) : (
              <Card className="p-8 text-center md:p-12">
                <MessageCircleQuestion className="mx-auto h-10 w-10 text-brand" aria-hidden />
                <h3 className="mt-4 text-xl font-bold text-text">
                  {view === "waiting" ? "Нет вопросов без ответа" : view === "progress" ? "Нет материалов в работе" : "Закрытых вопросов пока нет"}
                </h3>
                <p className="mx-auto mt-2 max-w-md text-pretty text-[14px] leading-relaxed text-text-3">
                  {view === "waiting"
                    ? "Добавьте реальный вопрос справа. Если его зададут снова, Аврора поднимет частоту, а не создаст дубликат."
                    : view === "progress"
                      ? "Выберите вопрос в очереди и создайте ответ — Аврора подготовит пост и свяжет его с запросом."
                      : "После публикации отмечайте вопрос отвеченным, чтобы видеть покрытие спроса."}
                </p>
              </Card>
            )}
          </section>

          <aside className="order-first lg:order-last lg:sticky lg:top-24" aria-labelledby="add-question-heading">
            <Card className="p-5 md:p-6">
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm bg-info-soft text-brand" aria-hidden>
                  <Plus className="h-5 w-5" />
                </span>
                <div>
                  <h2 id="add-question-heading" className="text-xl font-bold text-text">Добавить вопрос</h2>
                  <p className="type-caption mt-0.5 text-text-3">Зафиксируйте спрос, а не идею редакции</p>
                </div>
              </div>

              <form className="mt-6 space-y-4" onSubmit={createQuestion} noValidate>
                {formError && (
                  <p
                    ref={formErrorRef}
                    role="alert"
                    tabIndex={-1}
                    className="rounded-sm bg-danger-soft px-3 py-2.5 text-[13px] font-semibold text-danger-text outline-none focus-visible:ring-4 focus-visible:ring-danger/15"
                  >
                    {formError}
                  </p>
                )}
                <Field
                  label="Что спросил человек?"
                  htmlFor="audience-question"
                  required
                  error={questionFieldError || undefined}
                  messageId="audience-question-error"
                >
                  <Textarea
                    ref={questionRef}
                    id="audience-question"
                    rows={4}
                    value={question}
                    maxLength={600}
                    aria-invalid={Boolean(questionFieldError) || undefined}
                    aria-describedby={questionFieldError ? "audience-question-error" : undefined}
                    placeholder="Например: как подготовиться к проверке, если уведомление уже пришло?"
                    onChange={(event) => { setQuestion(event.target.value); setQuestionFieldError(""); setFormError(""); }}
                  />
                </Field>

                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                  <Field label="Тема" htmlFor="audience-topic" hint="Можно оставить пустой">
                    <Input id="audience-topic" value={topic} maxLength={160} placeholder="Проверки" onChange={(event) => setTopic(event.target.value)} />
                  </Field>
                  <Field label="Сколько раз спрашивали" htmlFor="audience-occurrences" error={occurrencesError || undefined} messageId="audience-occurrences-error">
                    <Input
                      id="audience-occurrences"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={10000}
                      value={occurrences}
                      aria-invalid={Boolean(occurrencesError) || undefined}
                      aria-describedby={occurrencesError ? "audience-occurrences-error" : undefined}
                      onChange={(event) => { setOccurrences(event.target.value); setOccurrencesError(""); }}
                    />
                  </Field>
                </div>

                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                  <Field label="Приоритет" htmlFor="audience-priority">
                    <select id="audience-priority" className={SELECT_CLASS} value={priority} onChange={(event) => setPriority(Number(event.target.value) as AudienceQuestionPriority)}>
                      {([1, 2, 3] as const).map((value) => <option key={value} value={value}>{PRIORITY_LABELS[value]}</option>)}
                    </select>
                  </Field>
                  <Field label="Источник" htmlFor="audience-source">
                    <select id="audience-source" className={SELECT_CLASS} value={sourceType} onChange={(event) => setSourceType(event.target.value as AudienceQuestionSource)}>
                      {(Object.entries(SOURCE_LABELS) as Array<[AudienceQuestionSource, string]>).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </Field>
                </div>

                <details className="rounded-sm bg-surface-inset p-4">
                  <summary className="min-h-11 cursor-pointer py-2 text-[14px] font-semibold text-text">Добавить контекст и ссылку</summary>
                  <div className="mt-3 space-y-4">
                    <Field label="Название источника" htmlFor="audience-source-label">
                      <Input id="audience-source-label" value={sourceLabel} maxLength={200} placeholder="Комментарии под постом" onChange={(event) => setSourceLabel(event.target.value)} />
                    </Field>
                    <Field
                      label="Ссылка на источник"
                      htmlFor="audience-source-url"
                      hint="Только защищённая ссылка https://"
                      error={sourceUrlError || undefined}
                      messageId="audience-source-url-message"
                    >
                      <Input
                        id="audience-source-url"
                        type="url"
                        inputMode="url"
                        value={sourceUrl}
                        maxLength={2048}
                        placeholder="https://…"
                        aria-invalid={Boolean(sourceUrlError) || undefined}
                        aria-describedby="audience-source-url-message"
                        onChange={(event) => { setSourceUrl(event.target.value); setSourceUrlError(""); }}
                      />
                    </Field>
                    <Field label="Контекст" htmlFor="audience-context">
                      <Textarea id="audience-context" rows={3} value={context} maxLength={2000} placeholder="Что происходило и почему возник вопрос" onChange={(event) => setContext(event.target.value)} />
                    </Field>
                  </div>
                </details>

                <Button type="submit" variant="primary" className="w-full" loading={busyId === "create"}>
                  {busyId !== "create" && <Plus className="h-4 w-4" aria-hidden />}
                  Добавить в очередь
                </Button>
              </form>
            </Card>
          </aside>
        </div>
      </div>
    </AppShell>
  );
}
