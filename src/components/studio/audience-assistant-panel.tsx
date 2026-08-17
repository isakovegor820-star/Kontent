"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  BellRing,
  Check,
  CheckCircle2,
  Clipboard,
  MessageCircle,
  Plus,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  UserRound,
} from "lucide-react";

import { Button, buttonClassName } from "@/components/ui/button";
import { Badge, Card, Field, Input, Textarea } from "@/components/ui/primitives";
import type {
  AudienceAssistantCapabilities,
  AudienceAssistantStats,
  AudienceInquiryRecord,
  AudienceInquirySource,
  AudienceInquiryStatus,
  AudienceReplyRisk,
  AudienceReplyTone,
} from "@/lib/audience-assistant";
import { createClientUuid } from "@/lib/client-uuid";
import { cn } from "@/lib/utils";

type AssistantView = "waiting" | "ready" | "closed";
type ApiError = { error?: string; requestId?: string };

const EMPTY_STATS: AudienceAssistantStats = {
  waiting: 0,
  ready: 0,
  answered: 0,
  dismissed: 0,
  highRisk: 0,
};

const EMPTY_CAPABILITIES: AudienceAssistantCapabilities = {
  canCreate: false,
  canEdit: false,
  canSend: false,
};

const SOURCE_LABELS: Record<AudienceInquirySource, string> = {
  telegram_business: "Telegram Business",
  comment: "Комментарий",
  direct_message: "Личное сообщение",
  support: "Поддержка",
  review: "Отзыв",
  other: "Другой источник",
};

const STATUS_LABELS: Record<AudienceInquiryStatus, string> = {
  pending: "Нужен ответ",
  reply_ready: "Ответ готов",
  approved: "Отправляется",
  sent: "Отвечено",
  dismissed: "Без ответа",
  failed: "Нужно повторить",
};

const TONE_LABELS: Record<AudienceReplyTone, string> = {
  positive: "Позитивный тон",
  neutral: "Нейтральный тон",
  negative: "Недовольство",
  aggressive: "Резкий тон",
};

const RISK_LABELS: Record<AudienceReplyRisk, string> = {
  low: "Низкий риск",
  medium: "Нужна проверка",
  high: "Высокий риск",
};

const SELECT_CLASS = cn(
  "type-input h-12 w-full rounded-xs border border-line bg-surface px-4 text-text",
  "transition-colors hover:border-line-strong focus:border-brand focus:outline-none",
  "focus-visible:ring-4 focus-visible:ring-brand/15",
);

function assistantError(code: string | undefined): string {
  if (code === "version_conflict") return "Обращение изменилось в другой вкладке. Обновите список и повторите.";
  if (code === "invalid_status") return "Для этого обращения действие уже недоступно. Обновите список.";
  if (code === "not_sendable") return "Это входящее добавлено вручную, поэтому Аврора не знает, куда отправить ответ. Скопируйте текст и ответьте на площадке.";
  if (code === "delivery_in_progress") return "Telegram уже обрабатывает отправку. Обновите список через несколько секунд.";
  if (code === "delivery_unknown") return "Telegram не подтвердил результат. Проверьте ветку комментариев перед повторной отправкой, чтобы не создать дубль.";
  if (code === "telegram_not_configured") return "Telegram-бот не подключён. Проверьте настройки интеграции.";
  if (code === "telegram_rejected") return "Telegram не принял ответ. Проверьте права бота и повторите отправку.";
  if (code === "access_denied") return "Недостаточно прав для работы с ответами этого проекта.";
  if (code === "limit") return "Дневной лимит AI-ответов исчерпан.";
  if (code === "request_in_progress") return "Аврора уже готовит этот ответ. Подождите несколько секунд.";
  if (code === "engine_not_connected") return "Выбранная AI-модель не подключена. Проверьте настройки AI.";
  if (code === "engine_offline") return "AI-модель сейчас недоступна. Попробуйте ещё раз позже.";
  if (code === "first_token_timeout" || code === "overall_timeout") return "AI-модель отвечает слишком долго. Повторите попытку.";
  if (code === "rate_limited") return "AI-сервис временно ограничил запросы. Повторите позже.";
  if (code === "invalid_ai_response") return "Аврора получила неполный ответ от AI. Повторите генерацию.";
  if (code === "payload_too_large") return "Сократите сообщение или контекст и повторите.";
  if (code === "invalid_request" || code === "bad_request") return "Проверьте заполненные поля и повторите.";
  return "Не удалось выполнить действие. Проверьте соединение и повторите.";
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json().catch(() => null) as (T & ApiError) | null;
  if (!response.ok || !body) {
    const error = new Error(assistantError(body?.error));
    (error as Error & { code?: string }).code = body?.error;
    throw error;
  }
  return body;
}

function relativeDate(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1_000));
  if (seconds < 60) return "только что";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин. назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч. назад`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "вчера";
  if (days < 7) return `${days} дн. назад`;
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" }).format(new Date(value));
}

function AssistantStat({ icon, label, value, hint }: {
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

function InquiryCard({
  inquiry,
  busy,
  canEdit,
  onGenerate,
  onSend,
  onUpdate,
  onMessage,
}: {
  inquiry: AudienceInquiryRecord;
  busy: boolean;
  canEdit: boolean;
  onGenerate: (inquiry: AudienceInquiryRecord) => void;
  onSend: (inquiry: AudienceInquiryRecord, reply: string) => void;
  onUpdate: (inquiry: AudienceInquiryRecord, input: { status?: AudienceInquiryStatus; suggestedReply?: string }) => void;
  onMessage: (message: string) => void;
}) {
  const [reply, setReply] = useState(inquiry.suggestedReply ?? "");
  const changed = reply.trim() !== (inquiry.suggestedReply ?? "").trim();
  const deliveryUnknown = inquiry.deliveryErrorCode === "delivery_unknown";
  const canAct = ["pending", "reply_ready", "failed"].includes(inquiry.status);

  const copyReply = async () => {
    try {
      await navigator.clipboard.writeText(reply);
      onMessage("Ответ скопирован. Проверьте его перед отправкой.");
    } catch {
      onMessage("Не удалось скопировать автоматически. Выделите текст ответа вручную.");
    }
  };

  return (
    <Card as="article" className={cn("overflow-hidden", inquiry.riskLevel === "high" && "ring-1 ring-danger/35")}>
      <div className="p-5 md:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={inquiry.status === "sent" ? "success" : inquiry.status === "failed" ? "danger" : "neutral"}>
                {deliveryUnknown ? "Проверьте отправку" : STATUS_LABELS[inquiry.status]}
              </Badge>
              {inquiry.riskLevel && (
                <Badge tone={inquiry.riskLevel === "high" ? "danger" : inquiry.riskLevel === "medium" ? "fire" : "success"}>
                  {RISK_LABELS[inquiry.riskLevel]}
                </Badge>
              )}
              {inquiry.tone && <span className="type-caption text-text-3">{TONE_LABELS[inquiry.tone]}</span>}
              <span className="type-caption text-text-3">{relativeDate(inquiry.createdAt)}</span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-text-3">
              <span className="inline-flex items-center gap-1.5 font-semibold text-text-2">
                <UserRound className="h-4 w-4 text-brand" aria-hidden />
                {inquiry.authorName || "Автор не указан"}
              </span>
              <span>{inquiry.sourceLabel || SOURCE_LABELS[inquiry.sourceType]}</span>
              {inquiry.sourceUrl && (
                <a
                  href={inquiry.sourceUrl}
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

        <blockquote className="mt-4 border-l-2 border-brand/30 pl-4 text-pretty text-[15px] leading-relaxed text-text">
          {inquiry.incomingText}
        </blockquote>
        {inquiry.context && <p className="mt-3 text-[13px] leading-relaxed text-text-3">Контекст: {inquiry.context}</p>}
      </div>

      {inquiry.replyGuidance && (
        <div className={cn(
          "mx-5 mb-4 flex gap-3 rounded-sm p-4 md:mx-6",
          inquiry.riskLevel === "high" ? "bg-danger-soft text-danger-text" : "bg-info-soft text-info-text",
        )}>
          {inquiry.riskLevel === "high"
            ? <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
            : <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />}
          <div>
            <p className="type-label">Как лучше ответить</p>
            <p className="mt-1 text-[13px] leading-relaxed">{inquiry.replyGuidance}</p>
          </div>
        </div>
      )}

      {inquiry.suggestedReply ? (
        <div className="border-t border-line px-5 py-5 md:px-6">
          <Field
            label="Черновик ответа"
            htmlFor={`audience-reply-${inquiry.id}`}
            hint={inquiry.canSendViaTelegram && inquiry.canDeliverReply
              ? "Проверьте текст: отправка опубликует его в Telegram сразу"
              : inquiry.canSendViaTelegram
                ? "Проверьте текст и передайте его согласующему, издателю или владельцу"
                : "Отредактируйте текст перед отправкой"}
          >
            <Textarea
              id={`audience-reply-${inquiry.id}`}
              rows={4}
              value={reply}
              maxLength={inquiry.canSendViaTelegram ? 4_096 : 8_000}
              disabled={!canEdit || busy || inquiry.status === "approved" || inquiry.status === "sent" || inquiry.status === "dismissed"}
              onChange={(event) => setReply(event.target.value)}
            />
          </Field>
          {inquiry.status === "approved" && (
            <div role="status" className="mt-4 flex gap-3 rounded-sm bg-info-soft p-4 text-[13px] leading-relaxed text-info-text">
              <Send className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              Telegram подтверждает отправку. Аврора не запустит её повторно, пока результат неизвестен.
            </div>
          )}
          {deliveryUnknown && (
            <div role="alert" className="mt-4 flex gap-3 rounded-sm bg-fire-soft p-4 text-[13px] leading-relaxed text-fire-text">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <p>Результат отправки неизвестен. Проверьте переписку в Telegram, затем подтвердите результат или разрешите повтор.</p>
            </div>
          )}
          {inquiry.canSendViaTelegram && !inquiry.canDeliverReply && canAct && (
            <div className="mt-4 flex gap-3 rounded-sm bg-info-soft p-4 text-[13px] leading-relaxed text-info-text">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <p>Отправить ответ в Telegram может согласующий, издатель или владелец проекта. Вы можете подготовить и скопировать текст.</p>
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            {deliveryUnknown && inquiry.canDeliverReply && (
              <>
                <Button variant="secondary" loading={busy} onClick={() => onUpdate(inquiry, { status: "sent" })}>
                  {!busy && <CheckCircle2 className="h-4 w-4" aria-hidden />}
                  Ответ уже отправлен
                </Button>
                <Button variant="secondary" loading={busy} onClick={() => onUpdate(inquiry, { status: "pending" })}>
                  {!busy && <RotateCcw className="h-4 w-4" aria-hidden />}
                  Разрешить повтор
                </Button>
              </>
            )}
            {inquiry.status !== "sent" && inquiry.status !== "dismissed" && (
              <>
                {inquiry.canSendViaTelegram && inquiry.canDeliverReply && canAct && !deliveryUnknown && (
                  <Button variant="primary" loading={busy} disabled={!reply.trim()} onClick={() => onSend(inquiry, reply)}>
                    {!busy && <Send className="h-4 w-4" aria-hidden />}
                    Отправить в Telegram
                  </Button>
                )}
                <Button variant={inquiry.canSendViaTelegram ? "secondary" : "primary"} disabled={!reply.trim()} onClick={() => void copyReply()}>
                  <Clipboard className="h-4 w-4" aria-hidden />
                  Скопировать ответ
                </Button>
                {canEdit && changed && canAct && !deliveryUnknown && (
                  <Button loading={busy} onClick={() => onUpdate(inquiry, { suggestedReply: reply })}>
                    {!busy && <Check className="h-4 w-4" aria-hidden />}
                    Сохранить правки
                  </Button>
                )}
                {canEdit && canAct && !deliveryUnknown && (
                  <Button variant="secondary" loading={busy} onClick={() => onGenerate(inquiry)}>
                    {!busy && <Sparkles className="h-4 w-4" aria-hidden />}
                    Другой вариант
                  </Button>
                )}
                {canEdit && !inquiry.canSendViaTelegram && (
                  <Button variant="ghost" loading={busy} onClick={() => onUpdate(inquiry, { status: "sent", suggestedReply: reply })}>
                    {!busy && <CheckCircle2 className="h-4 w-4" aria-hidden />}
                    Отметить отвеченным
                  </Button>
                )}
              </>
            )}
            {canEdit && (inquiry.status === "sent" || inquiry.status === "dismissed") && (
              <Button variant="secondary" loading={busy} onClick={() => onUpdate(inquiry, { status: "pending" })}>
                {!busy && <RotateCcw className="h-4 w-4" aria-hidden />}
                Вернуть в работу
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 border-t border-line px-5 py-4 md:px-6">
          {!canEdit ? (
            <p className="text-[13px] leading-relaxed text-text-3">
              Подготовить ответ может автор, согласующий или владелец проекта.
            </p>
          ) : inquiry.status !== "dismissed" ? (
            <>
              <Button variant="primary" loading={busy} onClick={() => onGenerate(inquiry)}>
                {!busy && <Sparkles className="h-4 w-4" aria-hidden />}
                Подготовить ответ
              </Button>
              <Button variant="ghost" loading={busy} onClick={() => onUpdate(inquiry, { status: "dismissed" })}>
                Без ответа
              </Button>
            </>
          ) : (
            <Button variant="secondary" loading={busy} onClick={() => onUpdate(inquiry, { status: "pending" })}>
              {!busy && <RotateCcw className="h-4 w-4" aria-hidden />}
              Вернуть в работу
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

export function AudienceAssistantPanel() {
  const incomingRef = useRef<HTMLTextAreaElement>(null);
  const formErrorRef = useRef<HTMLParagraphElement>(null);
  const [inquiries, setInquiries] = useState<AudienceInquiryRecord[]>([]);
  const [stats, setStats] = useState<AudienceAssistantStats>(EMPTY_STATS);
  const [capabilities, setCapabilities] = useState<AudienceAssistantCapabilities | null>(null);
  const [view, setView] = useState<AssistantView>("waiting");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [busyId, setBusyId] = useState<number | "create" | null>(null);
  const [formError, setFormError] = useState("");
  const [incomingError, setIncomingError] = useState("");
  const [urlError, setUrlError] = useState("");
  const [sourceType, setSourceType] = useState<Exclude<AudienceInquirySource, "telegram_business">>("comment");
  const [authorName, setAuthorName] = useState("");
  const [incomingText, setIncomingText] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [context, setContext] = useState("");

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setLoadError("");
    try {
      const result = await json<{
        inquiries: AudienceInquiryRecord[];
        stats: AudienceAssistantStats;
        capabilities: AudienceAssistantCapabilities;
      }>(
        "/api/audience-assistant",
      );
      setInquiries(result.inquiries);
      setStats(result.stats);
      setCapabilities(result.capabilities);
    } catch (error) {
      setLoadError((error as Error).message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible" && busyId == null) void load(true);
    }, 30_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [busyId, load]);

  useEffect(() => {
    if (formError) formErrorRef.current?.focus();
  }, [formError]);

  const visible = useMemo(() => inquiries.filter((item) => {
    if (view === "waiting") return item.status === "pending" || item.status === "failed";
    if (view === "ready") return item.status === "reply_ready" || item.status === "approved";
    return item.status === "sent" || item.status === "dismissed";
  }), [inquiries, view]);

  const replaceInquiry = (next: AudienceInquiryRecord) => {
    setInquiries((current) => current.some((item) => item.id === next.id)
      ? current.map((item) => item.id === next.id ? next : item)
      : [next, ...current]);
  };

  const createInquiry = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!capabilities?.canCreate) return;
    setFormError("");
    setIncomingError("");
    setUrlError("");
    setStatusMessage("");
    if (!incomingText.trim()) {
      setIncomingError("Вставьте текст комментария или сообщения.");
      incomingRef.current?.focus();
      return;
    }
    if (sourceUrl.trim()) {
      try {
        if (new URL(sourceUrl.trim()).protocol !== "https:") throw new Error("protocol");
      } catch {
        setUrlError("Введите полную защищённую ссылку, которая начинается с https://");
        document.getElementById("assistant-source-url")?.focus();
        return;
      }
    }
    setBusyId("create");
    try {
      const result = await json<{ inquiry: AudienceInquiryRecord; duplicate: boolean }>(
        "/api/audience-assistant",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requestKey: `audience-inquiry:${createClientUuid()}`,
            sourceType,
            sourceLabel: sourceLabel || null,
            sourceUrl: sourceUrl || null,
            authorName: authorName || null,
            incomingText,
            context: context || null,
          }),
        },
      );
      replaceInquiry(result.inquiry);
      setAuthorName("");
      setIncomingText("");
      setSourceLabel("");
      setSourceUrl("");
      setContext("");
      setView("waiting");
      setStatusMessage(result.duplicate ? "Это обращение уже добавлено." : "Обращение добавлено. Аврора готова подготовить ответ.");
      await load(true);
      incomingRef.current?.focus();
    } catch (error) {
      setFormError((error as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const generate = async (inquiry: AudienceInquiryRecord) => {
    setBusyId(inquiry.id);
    setLoadError("");
    setStatusMessage("Аврора анализирует тон и готовит безопасный ответ…");
    try {
      const result = await json<{ inquiry: AudienceInquiryRecord }>(
        `/api/audience-assistant/${inquiry.id}/reply`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedVersion: inquiry.version }),
        },
      );
      replaceInquiry(result.inquiry);
      setView("ready");
      setStatusMessage("Черновик готов. Проверьте совет Авроры и отредактируйте ответ перед отправкой.");
      await load(true);
    } catch (error) {
      setLoadError((error as Error).message);
      setStatusMessage("");
    } finally {
      setBusyId(null);
    }
  };

  const update = async (
    inquiry: AudienceInquiryRecord,
    input: { status?: AudienceInquiryStatus; suggestedReply?: string },
  ) => {
    setBusyId(inquiry.id);
    setLoadError("");
    setStatusMessage("");
    try {
      const result = await json<{ inquiry: AudienceInquiryRecord }>(
        `/api/audience-assistant/${inquiry.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedVersion: inquiry.version, ...input }),
        },
      );
      replaceInquiry(result.inquiry);
      setStatusMessage(input.status === "sent"
        ? "Обращение отмечено отвеченным."
        : input.status === "dismissed"
          ? "Обращение закрыто без ответа."
          : input.status === "pending"
            ? "Обращение возвращено в работу."
            : "Правки ответа сохранены.");
      await load(true);
    } catch (error) {
      setLoadError((error as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const sendReply = async (inquiry: AudienceInquiryRecord, reply: string) => {
    setBusyId(inquiry.id);
    setLoadError("");
    setStatusMessage("Отправляем ответ в Telegram…");
    try {
      const result = await json<{ inquiry: AudienceInquiryRecord; replayed: boolean }>(
        `/api/audience-assistant/${inquiry.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedVersion: inquiry.version,
            requestKey: `audience-delivery:${createClientUuid()}`,
            reply,
          }),
        },
      );
      replaceInquiry(result.inquiry);
      setView("closed");
      setStatusMessage(result.replayed
        ? "Этот ответ уже был отправлен в Telegram."
        : "Ответ отправлен в Telegram и отмечен отвеченным.");
      await load(true);
    } catch (error) {
      setLoadError((error as Error).message);
      setStatusMessage("");
      await load(true);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <section aria-label="Состояние помощника" className="grid gap-3 min-[360px]:grid-cols-2 xl:grid-cols-4">
        <AssistantStat icon={<BellRing className="h-5 w-5" />} label="Новые" value={stats.waiting} hint="Комментарии и сообщения, которым нужен ответ" />
        <AssistantStat icon={<Sparkles className="h-5 w-5" />} label="Ответ готов" value={stats.ready} hint="Черновики ждут вашей проверки" />
        <AssistantStat icon={<CheckCircle2 className="h-5 w-5" />} label="Отвечено" value={stats.answered} hint="Закрытые диалоги с аудиторией" />
        <AssistantStat icon={<AlertTriangle className="h-5 w-5" />} label="Высокий риск" value={stats.highRisk} hint="Лучше передать ответственному человеку" />
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
        <section aria-labelledby="assistant-inbox-heading" className="min-w-0 space-y-4">
          <div>
            <h2 id="assistant-inbox-heading" className="text-2xl font-bold tracking-tight text-text">Входящие от аудитории</h2>
            <p className="mt-1 max-w-[68ch] text-pretty text-[14px] leading-relaxed text-text-3">
              Аврора определит тон и риск, предложит тактику и подготовит ответ. Ничего не отправляется без вашей проверки.
            </p>
            <div className="mt-4 flex flex-wrap gap-2" aria-label="Фильтр входящих">
              {([
                ["waiting", `Нужен ответ · ${stats.waiting}`],
                ["ready", `Черновики · ${stats.ready}`],
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
              <p role="status" className="text-[14px] text-text-3">Загружаем входящие…</p>
            </Card>
          ) : visible.length > 0 ? (
            <div className="space-y-3">
              {visible.map((inquiry) => (
                <InquiryCard
                  key={`${inquiry.id}:${inquiry.version}`}
                  inquiry={inquiry}
                  busy={busyId === inquiry.id}
                  canEdit={capabilities?.canEdit ?? EMPTY_CAPABILITIES.canEdit}
                  onGenerate={(next) => void generate(next)}
                  onSend={(next, reply) => void sendReply(next, reply)}
                  onUpdate={(next, input) => void update(next, input)}
                  onMessage={setStatusMessage}
                />
              ))}
            </div>
          ) : (
            <Card className="p-8 text-center md:p-12">
              <MessageCircle className="mx-auto h-10 w-10 text-brand" aria-hidden />
              <h3 className="mt-4 text-xl font-bold text-text">
                {view === "waiting" ? "Все входящие разобраны" : view === "ready" ? "Нет черновиков на проверке" : "Закрытых обращений пока нет"}
              </h3>
              <p className="mx-auto mt-2 max-w-md text-pretty text-[14px] leading-relaxed text-text-3">
                {view === "waiting"
                  ? "После подключения бота новые сообщения и комментарии из группы обсуждений появятся здесь автоматически. Ранее отправленные обращения можно добавить справа."
                  : view === "ready"
                    ? "Выберите новое обращение и попросите Аврору подготовить ответ."
                    : "После ответа отметьте обращение закрытым, чтобы сохранить историю работы."}
              </p>
            </Card>
          )}
        </section>

        <aside className="space-y-4 lg:sticky lg:top-24" aria-labelledby="add-inquiry-heading">
          <Card className="p-5 md:p-6">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm bg-info-soft text-brand" aria-hidden>
                <Plus className="h-5 w-5" />
              </span>
              <div>
                <h2 id="add-inquiry-heading" className="text-xl font-bold text-text">Добавить входящее</h2>
                <p className="type-caption mt-0.5 text-text-3">Для площадок без автоматического импорта</p>
              </div>
            </div>

            {capabilities == null ? (
              <p role="status" className="mt-6 text-[14px] text-text-3">Проверяем права проекта…</p>
            ) : capabilities.canCreate ? (
            <form className="mt-6 space-y-4" onSubmit={createInquiry} noValidate>
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
              <Field label="Источник" htmlFor="assistant-source">
                <select
                  id="assistant-source"
                  className={SELECT_CLASS}
                  value={sourceType}
                  onChange={(event) => setSourceType(event.target.value as Exclude<AudienceInquirySource, "telegram_business">)}
                >
                  {(["comment", "direct_message", "support", "review", "other"] as const).map((source) => (
                    <option key={source} value={source}>{SOURCE_LABELS[source]}</option>
                  ))}
                </select>
              </Field>
              <Field label="Имя автора" htmlFor="assistant-author" hint="Можно оставить пустым">
                <Input id="assistant-author" value={authorName} maxLength={200} placeholder="Анна" onChange={(event) => setAuthorName(event.target.value)} />
              </Field>
              <Field
                label="Комментарий или сообщение"
                htmlFor="assistant-incoming"
                required
                error={incomingError || undefined}
                messageId="assistant-incoming-error"
              >
                <Textarea
                  ref={incomingRef}
                  id="assistant-incoming"
                  rows={5}
                  value={incomingText}
                  maxLength={8_000}
                  aria-invalid={Boolean(incomingError) || undefined}
                  aria-describedby={incomingError ? "assistant-incoming-error" : undefined}
                  placeholder="Вставьте сообщение человека без изменений"
                  onChange={(event) => { setIncomingText(event.target.value); setIncomingError(""); setFormError(""); }}
                />
              </Field>
              <details className="rounded-sm bg-surface-inset p-4">
                <summary className="min-h-11 cursor-pointer py-2 text-[14px] font-semibold text-text">Добавить источник и контекст</summary>
                <div className="mt-3 space-y-4">
                  <Field label="Название площадки" htmlFor="assistant-source-label">
                    <Input id="assistant-source-label" value={sourceLabel} maxLength={200} placeholder="VK · пост о запуске" onChange={(event) => setSourceLabel(event.target.value)} />
                  </Field>
                  <Field
                    label="Ссылка на сообщение"
                    htmlFor="assistant-source-url"
                    error={urlError || undefined}
                    messageId="assistant-source-url-error"
                  >
                    <Input
                      id="assistant-source-url"
                      type="url"
                      inputMode="url"
                      value={sourceUrl}
                      maxLength={2_048}
                      placeholder="https://…"
                      aria-invalid={Boolean(urlError) || undefined}
                      aria-describedby={urlError ? "assistant-source-url-error" : undefined}
                      onChange={(event) => { setSourceUrl(event.target.value); setUrlError(""); }}
                    />
                  </Field>
                  <Field label="Контекст" htmlFor="assistant-context" hint="Например, о каком товаре или публикации речь">
                    <Textarea id="assistant-context" rows={3} value={context} maxLength={4_000} onChange={(event) => setContext(event.target.value)} />
                  </Field>
                </div>
              </details>
              <Button type="submit" variant="primary" className="w-full" loading={busyId === "create"}>
                {busyId !== "create" && <Plus className="h-4 w-4" aria-hidden />}
                Добавить входящее
              </Button>
            </form>
            ) : (
              <div className="mt-6 flex gap-3 rounded-sm bg-info-soft p-4 text-[13px] leading-relaxed text-info-text">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <p>Добавить входящее может автор, согласующий или владелец проекта. Вы можете просматривать очередь и выполнять доступные вашей роли действия.</p>
              </div>
            )}
          </Card>

          <Card className="p-5 md:p-6">
            <div className="flex gap-3">
              <BellRing className="mt-0.5 h-5 w-5 shrink-0 text-brand" aria-hidden />
              <div>
                <h3 className="font-bold text-text">Подключите группу Telegram</h3>
                <p className="mt-1 text-[13px] leading-relaxed text-text-3">
                  Добавьте бота Авроры администратором в группу обсуждений канала. Новые сообщения и комментарии появятся здесь автоматически.
                </p>
                <ol className="mt-3 list-decimal space-y-1 ps-4 text-[13px] leading-relaxed text-text-3">
                  <li>Откройте группу обсуждений канала.</li>
                  <li>Добавьте бота и выдайте ему права администратора.</li>
                  <li>Отправьте новое сообщение в группе или комментарий под публикацией.</li>
                </ol>
                <p className="mt-3 text-[13px] leading-relaxed text-text-3">
                  Telegram не передаёт боту комментарии, отправленные до подключения.
                </p>
                <Link href="/app/settings" className={buttonClassName({ variant: "secondary", size: "sm", className: "mt-4" })}>
                  Открыть настройки Telegram
                </Link>
              </div>
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}
