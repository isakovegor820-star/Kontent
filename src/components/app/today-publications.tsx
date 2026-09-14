"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CalendarClock, ChevronDown, Send } from "lucide-react";
import { Button, buttonClassName } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/primitives";
import { useProjectFetch } from "@/lib/use-project-transport";
import { publicationOperationFailureFeedback, publicationOperationReachedCalendar } from "@/lib/publication-operation-feedback";
import { localScheduleFieldsForInstant, resolveLocalSchedule } from "@/lib/timezone-schedule";
import type { TodayPublication } from "@/lib/today-publications";

const STATUS: Record<string, string> = {
  draft: "Черновик", approved: "Согласовано", in_review: "На проверке", changes_requested: "Нужны правки",
  scheduled: "Запланировано", publishing: "Публикуется", published: "Опубликовано",
  published_unverified: "Доставка проверяется", failed: "Ошибка публикации", failed_retry: "Повторная отправка",
  quarantined: "Нужно новое время", missing: "Пост не найден", deleted_external: "Удалён в канале",
};

type Props = { items: TodayPublication[]; available: boolean; projectId: number; channelId: number; channelLabel: string; timezone: string; onRefresh: (message: string) => void };

function PublicationRow({ item, projectId, channelLabel, timezone, onRefresh }: Pick<Props, "projectId" | "channelLabel" | "timezone" | "onRefresh"> & { item: TodayPublication }) {
  const projectFetch = useProjectFetch();
  const [localTime, setLocalTime] = useState(() => {
    const fields = localScheduleFieldsForInstant(item.scheduledAt ?? new Date(Date.now() + 3_600_000).toISOString(), timezone);
    return `${fields.localDate}T${fields.localTime}`;
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [failed, setFailed] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [hasAttempt, setHasAttempt] = useState(false);
  const attempt = useRef<{ key: string; schedule: ReturnType<typeof resolveLocalSchedule>; fingerprint: string | null } | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function publish(now: boolean) {
    if (busy || committed || !item.canPublish) return;
    setFailed(false); setNotice("");
    try {
      if (!attempt.current) {
        const [localDate, time] = localTime.split("T");
        const fields = now
          ? localScheduleFieldsForInstant(new Date().toISOString(), timezone)
          : { localDate, localTime: time, timezone };
        attempt.current = { key: crypto.randomUUID(), schedule: resolveLocalSchedule({ ...fields, disambiguation: "reject" }), fingerprint: null };
        if (!now && new Date(attempt.current.schedule.scheduledAt).getTime() <= Date.now()) {
          attempt.current = null;
          setFailed(true); setNotice("Выберите время в будущем или нажмите «Опубликовать сейчас»."); return;
        }
        setHasAttempt(true);
      }
    } catch {
      setFailed(true); setNotice("Выберите корректное время. Если час повторяется при переводе часов, уточните его в редакторе."); return;
    }
    setBusy(true);
    const request = new AbortController(); controller.current = request;
    try {
      const current = attempt.current;
      const response = await projectFetch("/api/publication-operations", {
        method: "POST", signal: request.signal,
        headers: { "content-type": "application/json", "idempotency-key": current.key, "x-aurora-project-id": String(projectId) },
        body: JSON.stringify({ draftId: item.draftId, draftVersion: item.draftVersion,
          timezone, schedule: current.schedule, operationFingerprint: current.fingerprint }),
      });
      const result = await response.json();
      if (request.signal.aborted) return;
      if (typeof result.fingerprint === "string") current.fingerprint = result.fingerprint;
      if (publicationOperationReachedCalendar(result)) {
        setCommitted(true);
        const plannedFor = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: timezone }).format(new Date(current.schedule.scheduledAt));
        const message = result.ok && result.result === "queued"
          ? `Публикация в очереди на ${plannedFor} (${timezone}). Статус доставки — в календаре.`
          : "Публикация сохранена. Проверьте очередь и состояние доставки в календаре.";
        setNotice(message);
        onRefresh(message);
      } else {
        setFailed(true);
        const message = publicationOperationFailureFeedback(result);
        setNotice(`${message.title}. ${message.body}`);
        if (result.result === "operation_not_created" && response.status >= 400 && response.status < 500) {
          attempt.current = null; setHasAttempt(false);
        }
      }
    } catch {
      if (request.signal.aborted) return;
      setFailed(true); setNotice("Не удалось получить ответ. Повторите запрос: используется тот же номер операции, чтобы не создать дубль.");
    } finally { if (!request.signal.aborted) setBusy(false); }
  }

  const title = item.text.trim().split("\n")[0]?.slice(0, 130) || "Материал без заголовка";
  return <li className="border-t border-line first:border-0">
    <details className="group p-4 sm:p-5">
      <summary className="flex min-h-11 cursor-pointer list-none items-start gap-3 rounded-xs focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand [&::-webkit-details-marker]:hidden">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={item.status === "published" ? "success" : ["failed", "quarantined"].includes(item.status) ? "danger" : "neutral"}>{STATUS[item.status] ?? "Проверьте статус в календаре"}</Badge>
            <span className="type-caption tabular-nums text-text-3">{item.scheduledAt ? new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short", timeZone: timezone }).format(new Date(item.scheduledAt)) : "Без времени"}</span>
          </div>
          <h3 className="mt-2 break-words text-[15px] font-semibold leading-relaxed text-text">{title}</h3>
          <span className="mt-1 block type-caption text-brand">Посмотреть материал и действия</span>
        </div>
        <ChevronDown className="mt-2 h-4 w-4 shrink-0 text-text-3 group-open:rotate-180" aria-hidden />
      </summary>
      <div className="mt-4 space-y-4">
        <p className="max-w-[65ch] whitespace-pre-wrap break-words text-[15px] leading-relaxed text-text-2">{item.text}</p>
        {item.media && <p className="text-sm text-text-2">Есть вложения. <Link href={item.href} className="text-brand underline underline-offset-4">Открыть полный предпросмотр в редакторе</Link></p>}
        <Link href={item.href} className={buttonClassName({ variant: "secondary", size: "sm", className: "min-h-11" })}>{item.status === "approved" ? "Открыть предпросмотр и настройки" : "Открыть в редакторе или календаре"}</Link>
        {item.canPublish && <div className="space-y-3 rounded-sm bg-surface-inset p-4">
          <p className="text-sm text-text-2">Согласованная версия · канал «{channelLabel}» · время {timezone}</p>
          <label className="block text-sm font-semibold text-text">
            Время публикации
            <input type="datetime-local" value={localTime} disabled={busy || committed || hasAttempt}
              onChange={(event) => setLocalTime(event.target.value)}
              className="mt-2 block min-h-11 w-full min-w-0 rounded-xs border border-line bg-surface px-3 text-base text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand sm:max-w-72" />
          </label>
          <div className="flex flex-wrap gap-2">
            {hasAttempt ? <Button loading={busy} disabled={committed} onClick={() => void publish(false)} className="min-h-11">{committed ? "Публикация сохранена" : "Повторить отправку запроса"}</Button>
              : <><Button loading={busy} disabled={committed} onClick={() => void publish(false)} className="min-h-11"><CalendarClock className="h-4 w-4" aria-hidden />Запланировать</Button>
                <Button variant="secondary" disabled={busy || committed} onClick={() => void publish(true)} className="min-h-11"><Send className="h-4 w-4" aria-hidden />Опубликовать сейчас</Button></>}
          </div>
        </div>}
        <p role={failed ? "alert" : "status"} className={`text-sm leading-relaxed ${failed ? "text-danger-text" : "text-text-2"}`}>{notice}</p>
      </div>
    </details>
  </li>;
}

export function TodayPublications(props: Props) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? props.items : props.items.slice(0, 5);
  return <section aria-labelledby="today-publications-title">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div><h2 id="today-publications-title">Публикации и материалы</h2><p className="mt-1 text-sm text-text-3">План на сегодня, согласованные материалы и отправки, требующие внимания.</p></div>
      <Link className={buttonClassName({ variant: "secondary", size: "sm", className: "min-h-11" })} href={`/app/composer?channel=${props.channelId}&from=today`}>Создать материал</Link>
    </div>
    <Card>
      {!props.available ? <p role="status" className="p-5 text-sm text-text-2">Не удалось загрузить публикации. <Link className="text-brand underline" href={`/app/calendar?channel=${props.channelId}`}>Открыть календарь</Link></p>
        : props.items.length === 0 ? <p className="p-5 text-sm leading-relaxed text-text-2">На сегодня нет публикаций и материалов в работе. Создайте материал или выберите тему ниже.</p>
          : <ul>{visible.map((item) => <PublicationRow key={`${item.key}:${item.draftVersion}`} item={item} {...props} />)}</ul>}
      {props.items.length > 5 && <div className="px-5 pb-4"><Button variant="ghost" size="sm" className="min-h-11" onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>{showAll ? "Свернуть список" : `Показать все (${props.items.length})`}</Button></div>}
    </Card>
  </section>;
}
