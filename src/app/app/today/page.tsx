"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  CircleHelp,
  MessageCircleMore,
  Newspaper,
  PencilLine,
  Plus,
  RefreshCw,
  ShieldAlert,
  Sparkles,
} from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { useProjects } from "@/components/app/project-provider";
import { Button, buttonClassName } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/primitives";
import { H2, H3, SecondaryText } from "@/components/ui/typography";
import { listServerDrafts } from "@/lib/draft-client";
import type { AudienceInquiryRecord, AudienceAssistantStats } from "@/lib/audience-assistant";
import type { AudienceQuestionRecord } from "@/lib/audience-questions";
import {
  buildTodayView,
  type TodayMetric,
  type TodaySnapshot,
  type TodayTask,
  type TodayTaskKind,
} from "@/lib/today";
import { cn, fmtNum, plural } from "@/lib/utils";

type AudienceResponse = Readonly<{
  ok: true;
  inquiries: AudienceInquiryRecord[];
  stats: AudienceAssistantStats;
}>;

type QuestionsResponse = Readonly<{
  ok: true;
  questions: AudienceQuestionRecord[];
}>;

type RssSummaryResponse = Readonly<{
  unreadCount: number;
}>;

const EMPTY_SNAPSHOT: TodaySnapshot = {
  drafts: null,
  audience: null,
  questions: null,
  rssUnreadCount: null,
};

const TASK_ICONS: Record<TodayTaskKind, typeof PencilLine> = {
  changes_requested: PencilLine,
  high_risk_reply: ShieldAlert,
  ready_reply: CheckCircle2,
  waiting_reply: MessageCircleMore,
  audience_question: CircleHelp,
  unscheduled_draft: CalendarClock,
  rss: Newspaper,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

async function getJson(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { cache: "no-store", signal });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || typeof body !== "object") throw new Error("request_failed");
  return body;
}

async function loadAudience(signal: AbortSignal): Promise<AudienceResponse> {
  const body = await getJson("/api/audience-assistant", signal);
  if (!isRecord(body) || body.ok !== true || !Array.isArray(body.inquiries) || !isRecord(body.stats)) {
    throw new Error("invalid_response");
  }
  const validStats = isCount(body.stats.waiting) && isCount(body.stats.ready) && isCount(body.stats.highRisk);
  const validInquiries = body.inquiries.every((item) => (
    isRecord(item)
    && Number.isSafeInteger(item.id)
    && typeof item.status === "string"
    && (item.riskLevel == null || typeof item.riskLevel === "string")
    && (item.authorName == null || typeof item.authorName === "string")
    && typeof item.incomingText === "string"
    && typeof item.createdAt === "string"
  ));
  if (!validStats || !validInquiries) throw new Error("invalid_response");
  return body as AudienceResponse;
}

async function loadQuestions(signal: AbortSignal): Promise<QuestionsResponse> {
  const body = await getJson("/api/audience-questions", signal);
  if (!isRecord(body) || body.ok !== true || !Array.isArray(body.questions)) {
    throw new Error("invalid_response");
  }
  const validQuestions = body.questions.every((item) => (
    isRecord(item)
    && Number.isSafeInteger(item.id)
    && typeof item.question === "string"
    && isCount(item.priority)
    && isCount(item.occurrences)
    && typeof item.status === "string"
    && typeof item.updatedAt === "string"
  ));
  if (!validQuestions) throw new Error("invalid_response");
  return body as QuestionsResponse;
}

async function loadRssSummary(signal: AbortSignal): Promise<RssSummaryResponse> {
  const body = await getJson("/api/rss/items?summary=unread", signal);
  if (!isRecord(body) || !isCount(body.unreadCount)) throw new Error("invalid_response");
  return body as RssSummaryResponse;
}

function metricCaption(metric: TodayMetric): string {
  if (metric.value == null) return "Не обновилось";
  if (metric.id === "audience") {
    return plural(metric.value, "ждёт действия", "ждут действия", "ждут действия");
  }
  if (metric.id === "drafts") {
    return plural(metric.value, "материал", "материала", "материалов");
  }
  return plural(metric.value, "материал", "материала", "материалов");
}

function TodaySkeleton() {
  return (
    <div role="status" aria-busy="true" className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <span className="sr-only">Собираем план на сегодня</span>
      <div className="space-y-4">
        <div className="skeleton h-11 w-64 rounded-sm" />
        {[0, 1, 2].map((item) => (
          <div key={item} className="skeleton h-52 rounded-md" />
        ))}
      </div>
      <div className="space-y-4">
        <div className="skeleton h-64 rounded-md" />
        <div className="skeleton h-40 rounded-md" />
      </div>
    </div>
  );
}

function TaskCard({ task, index }: { task: TodayTask; index: number }) {
  const Icon = TASK_ICONS[task.kind];
  const attention = task.kind === "changes_requested" || task.kind === "high_risk_reply";

  return (
    <Card as="article" className={cn(
      "p-5 sm:p-6",
      index === 0 && "border-brand/20 bg-surface/95 shadow-card",
    )}>
      <div className="flex items-start gap-4">
        <span className={cn(
          "grid h-11 w-11 shrink-0 place-items-center rounded-sm",
          attention ? "bg-fire-soft text-fire-text" : "bg-info-soft text-brand",
        )}>
          <Icon className="h-5 w-5" strokeWidth={1.9} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={attention ? "fire" : index === 0 ? "brand" : "neutral"}>
              {index === 0 ? "Начните отсюда" : task.label}
            </Badge>
            {index === 0 && task.label !== "Начните отсюда" ? (
              <span className="type-caption font-semibold text-text-3">{task.label}</span>
            ) : null}
          </div>
          <H3 className="mt-3 text-balance">{task.title}</H3>
          <SecondaryText className="mt-2 max-w-2xl text-pretty">{task.description}</SecondaryText>
          <Link
            href={task.href}
            className={buttonClassName({
              variant: "secondary",
              size: "sm",
              className: "mt-5 w-full sm:w-auto",
            })}
          >
            {task.actionLabel}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      </div>
    </Card>
  );
}

function EmptyToday() {
  return (
    <Card className="grid min-h-80 place-items-center p-6 text-center sm:p-10">
      <div className="max-w-lg">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-success-soft text-success-text">
          <CheckCircle2 className="h-6 w-6" aria-hidden />
        </span>
        <H3 className="mt-4">Срочных задач нет</H3>
        <SecondaryText className="mt-2 text-pretty">
          Всё важное по проекту разобрано. Можно создать новый материал или проверить календарь.
        </SecondaryText>
        <div className="mt-5 flex flex-col justify-center gap-2 sm:flex-row">
          <Link href="/app/studio?intent=create" className={buttonClassName({ variant: "secondary", size: "sm" })}>
            <Sparkles className="h-4 w-4" aria-hidden />
            Создать пост
          </Link>
          <Link href="/app/calendar" className={buttonClassName({ variant: "ghost", size: "sm" })}>
            Открыть календарь
          </Link>
        </div>
      </div>
    </Card>
  );
}

export default function TodayPage() {
  const projects = useProjects();
  const projectId = projects.current?.id ?? null;
  const requestRef = useRef<AbortController | null>(null);
  const loadedProjectRef = useRef<number | null>(null);
  const [snapshot, setSnapshot] = useState<TodaySnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [failedSources, setFailedSources] = useState(0);

  const load = useCallback(async () => {
    if (!projectId) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const firstLoadForProject = loadedProjectRef.current !== projectId;
    if (firstLoadForProject) setLoading(true);
    else setRefreshing(true);

    const results = await Promise.allSettled([
      listServerDrafts(controller.signal),
      loadAudience(controller.signal),
      loadQuestions(controller.signal),
      loadRssSummary(controller.signal),
    ]);
    if (controller.signal.aborted) return;

    const [drafts, audience, questions, rss] = results;
    const failures = results.filter((result) => result.status === "rejected").length;
    setSnapshot({
      drafts: drafts.status === "fulfilled" ? drafts.value : null,
      audience: audience.status === "fulfilled"
        ? { inquiries: audience.value.inquiries, stats: audience.value.stats }
        : null,
      questions: questions.status === "fulfilled" ? questions.value.questions : null,
      rssUnreadCount: rss.status === "fulfilled" && Number.isSafeInteger(rss.value.unreadCount)
        ? Math.max(0, rss.value.unreadCount)
        : null,
    });
    setFailedSources(failures);
    loadedProjectRef.current = projectId;
    setLoading(false);
    setRefreshing(false);
  }, [projectId]);

  useEffect(() => {
    if (!projects.ready) return;
    if (!projectId) {
      const timer = window.setTimeout(() => setLoading(false), 0);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load, projectId, projects.ready]);

  useEffect(() => () => requestRef.current?.abort(), []);

  const view = useMemo(() => buildTodayView(snapshot), [snapshot]);
  const allFailed = failedSources === 4;

  return (
    <AppShell
      title="Сегодня"
      subtitle="Три следующих действия по проекту — без поиска по разделам."
      action={(
        <Link
          href="/app/studio?intent=create"
          className={buttonClassName({ variant: "primary", className: "w-full sm:w-auto" })}
        >
          <Plus className="h-4 w-4" aria-hidden />
          Новый пост
        </Link>
      )}
    >
      {!projects.ready || loading ? (
        <TodaySkeleton />
      ) : !projectId ? (
        <Card role="alert" className="mx-auto max-w-2xl p-6 text-center sm:p-8">
          <H2>Сначала выберите проект</H2>
          <SecondaryText className="mt-2">
            План на сегодня строится отдельно для каждого проекта.
          </SecondaryText>
          {projects.error ? (
            <Button className="mt-5" variant="secondary" onClick={() => void projects.refresh()}>
              Повторить загрузку проектов
            </Button>
          ) : null}
        </Card>
      ) : allFailed ? (
        <Card role="alert" className="mx-auto max-w-2xl p-6 text-center sm:p-8">
          <H2>Не удалось собрать план</H2>
          <SecondaryText className="mt-2 text-pretty">
            Данные проекта не загрузились. Ничего не потеряно — попробуйте ещё раз.
          </SecondaryText>
          <Button className="mt-5" variant="secondary" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            Повторить
          </Button>
        </Card>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
          <section aria-labelledby="today-actions-title" className="min-w-0">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2.5">
                <H2 id="today-actions-title">Главное на сегодня</H2>
                <Badge tone={view.tasks.length > 0 ? "brand" : "success"}>
                  {view.tasks.length === 0
                    ? "Всё готово"
                    : `${view.tasks.length} ${plural(view.tasks.length, "действие", "действия", "действий")}`}
                </Badge>
              </div>
              <Button variant="ghost" size="sm" loading={refreshing} onClick={() => void load()}>
                {!refreshing ? <RefreshCw className="h-4 w-4" aria-hidden /> : null}
                Обновить
              </Button>
            </div>

            {failedSources > 0 ? (
              <div
                role="status"
                className="mb-4 rounded-sm border border-fire/20 bg-fire-soft px-4 py-3 text-[14px] font-medium text-fire-text"
              >
                Часть данных не обновилась. Показали всё, что удалось получить.
              </div>
            ) : null}

            {view.tasks.length > 0 ? (
              <ol className="space-y-4">
                {view.tasks.map((task, index) => (
                  <li key={task.id}>
                    <TaskCard task={task} index={index} />
                  </li>
                ))}
              </ol>
            ) : (
              <EmptyToday />
            )}
          </section>

          <aside aria-label="Сводка проекта" className="space-y-4">
            <Card className="p-5 sm:p-6">
              <H2>Коротко по проекту</H2>
              <ul className="mt-4 divide-y divide-line">
                {view.metrics.map((metric) => (
                  <li key={metric.id}>
                    <Link
                      href={metric.href}
                      aria-label={`${metric.label}: ${metric.value == null ? "не обновилось" : fmtNum(metric.value)}, ${metricCaption(metric)}`}
                      className="group flex min-h-16 items-center justify-between gap-3 py-3 focus-visible:rounded-xs"
                    >
                      <span className="min-w-0">
                        <span className="type-label block text-text">{metric.label}</span>
                        <span className="type-caption mt-0.5 block text-text-3">{metricCaption(metric)}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <span className="nums text-[24px] leading-none font-bold text-text">
                          {metric.value == null ? "—" : fmtNum(metric.value)}
                        </span>
                        <ArrowRight
                          className="h-4 w-4 text-text-3 transition-transform duration-150 group-hover:translate-x-0.5 motion-reduce:transform-none"
                          aria-hidden
                        />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>

            <Card className="border-brand/15 bg-info-soft/55 p-5 sm:p-6">
              <span className="grid h-10 w-10 place-items-center rounded-sm bg-surface text-brand shadow-soft">
                <Sparkles className="h-5 w-5" aria-hidden />
              </span>
              <H2 className="mt-4">Список меняется сам</H2>
              <SecondaryText className="mt-2 text-pretty">
                Аврора собирает действия из всех разделов. Выполните шаг и обновите экран — закрытая задача исчезнет.
              </SecondaryText>
            </Card>
          </aside>
        </div>
      )}
    </AppShell>
  );
}
