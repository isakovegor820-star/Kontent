"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { CheckCircle2, Clock3, ExternalLink, RotateCcw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  parsePublicationFollowupResponse,
  parsePublicationReviewDecisionResponse,
  PUBLICATION_EXTRA_LABELS,
  publicationExtraStatus,
  publicationFollowupError,
  type PublicationDestinationFollowup,
  type PublicationExtraView,
  type PublicationReviewView,
} from "@/lib/publication-followup-client";
import { cn } from "@/lib/utils";

const NETWORK_LABELS: Record<string, string> = { tg: "Telegram", vk: "VK" };
const DECISION_LABELS: Record<NonNullable<PublicationReviewView["decision"]>, string> = {
  keep: "Оставлено без изменений",
  update: "Запрошено обновление",
  unpin: "Запрошено открепление",
  remove_manually: "Отмечено для ручного снятия",
};

function reviewDate(review: PublicationReviewView) {
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: review.timezone,
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(review.reviewAt));
  } catch {
    return new Date(review.reviewAt).toLocaleString("ru-RU");
  }
}

function needsExternalConfirmation(extra: PublicationExtraView) {
  return extra.kind === "first_comment"
    && ["delivery_unknown", "telegram_comment_delivery_unknown"].includes(extra.error || "");
}

export function PublicationFollowupSection({
  operationId,
  onUpdateRequested,
}: {
  operationId: number;
  onUpdateRequested?: (draftId: number) => void;
}) {
  const statusId = useId();
  const [destinations, setDestinations] = useState<PublicationDestinationFollowup[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmedAbsent, setConfirmedAbsent] = useState<Set<number>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/publication-operations/${operationId}`, {
      cache: "no-store",
      signal,
    });
    const body = await response.json().catch(() => null);
    const parsed = response.ok ? parsePublicationFollowupResponse(body) : null;
    if (!parsed) throw body;
    return parsed;
  }, [operationId]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setLoading(true);
      setError(null);
    });
    void load(controller.signal)
      .then(setDestinations)
      .catch((reason) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError("Статусы дополнительных действий не загрузились. Основная публикация не затронута.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [load, reloadKey]);

  const refresh = async () => {
    const parsed = await load();
    setDestinations(parsed);
  };

  const retry = async (extra: PublicationExtraView) => {
    if (busyKey) return;
    const requiresConfirmation = needsExternalConfirmation(extra);
    if (requiresConfirmation && !confirmedAbsent.has(extra.id)) {
      setError("Сначала подтвердите, что комментария нет во внешнем канале.");
      return;
    }
    setBusyKey(`extra:${extra.id}`);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/publication-extra-operations/${extra.id}/retry`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `extra-retry:${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          expectedFingerprint: extra.fingerprint,
          verifiedAbsent: requiresConfirmation && confirmedAbsent.has(extra.id),
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || body.ok !== true) throw body;
      await refresh();
      setMessage("Повтор поставлен в очередь. Основной пост остаётся опубликованным.");
    } catch (reason) {
      setError(publicationFollowupError(reason));
    } finally {
      setBusyKey(null);
    }
  };

  const decide = async (
    review: PublicationReviewView,
    decision: NonNullable<PublicationReviewView["decision"]>,
  ) => {
    if (busyKey) return;
    setBusyKey(`review:${review.id}:${decision}`);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/publication-review-tasks/${review.id}/decision`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `review-decision:${crypto.randomUUID()}`,
        },
        body: JSON.stringify({ expectedVersion: review.version, decision }),
      });
      const body = await response.json().catch(() => null);
      const parsed = response.ok ? parsePublicationReviewDecisionResponse(body) : null;
      if (!parsed) {
        if (response.ok && decision === "update") {
          throw { error: "review_update_draft_missing" };
        }
        throw body;
      }
      if (decision === "update") {
        if (parsed.draftId == null) {
          throw { error: "review_update_draft_missing" };
        }
        if (onUpdateRequested) {
          onUpdateRequested(parsed.draftId);
          return;
        }
        await refresh();
        setMessage("Решение сохранено. Новый черновик готов к редактированию.");
        return;
      }
      await refresh();
      setMessage(
        decision === "unpin"
          ? "Решение сохранено. Открепление выполняется отдельно от основной публикации."
          : "Решение по актуальности сохранено.",
      );
    } catch (reason) {
      setError(publicationFollowupError(reason));
    } finally {
      setBusyKey(null);
    }
  };

  const hasFollowups = destinations?.some((destination) =>
    destination.extraOperations.length > 0 || destination.review != null,
  );

  return (
    <section
      className="mt-5 border-t border-line pt-5"
      aria-labelledby={`${statusId}-title`}
      aria-busy={loading || Boolean(busyKey) || undefined}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id={`${statusId}-title`} className="text-[15px] font-bold text-text">После публикации</h3>
          <p className="mt-1 text-[12px] leading-relaxed text-text-3">
            Комментарии, закрепление и пересмотр имеют отдельные статусы и не меняют результат основной отправки.
          </p>
        </div>
        {!loading && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setReloadKey((key) => key + 1)} disabled={Boolean(busyKey)}>
            <RotateCcw className="h-4 w-4" aria-hidden />
            Обновить
          </Button>
        )}
      </div>

      {loading ? (
        <p role="status" className="mt-3 text-[13px] text-text-3">Проверяем статусы…</p>
      ) : error && destinations == null ? (
        <p role="alert" className="mt-3 text-[13px] font-medium text-danger-text">{error}</p>
      ) : !hasFollowups ? (
        <p className="mt-3 text-[13px] text-text-3">Для этой публикации дополнительные действия не выбраны.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line border-y border-line">
          {destinations?.map((destination) => (
            <li key={destination.postId} className="py-4">
              <h4 className="text-[13px] font-semibold text-text">
                {destination.title || NETWORK_LABELS[destination.network] || destination.network}
              </h4>
              {destination.extraOperations.length > 0 && (
                <ul className="mt-2 space-y-2">
                  {destination.extraOperations.map((extra) => {
                    const status = publicationExtraStatus(extra);
                    const confirmationRequired = needsExternalConfirmation(extra);
                    const retryable = extra.status === "failed" || extra.status === "failed_retry";
                    return (
                      <li key={extra.id} className="rounded-xs bg-surface-2 px-3 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[13px] font-semibold text-text">{PUBLICATION_EXTRA_LABELS[extra.kind]}</span>
                          <span className={cn(
                            "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                            status.tone === "success" && "bg-success-soft text-success-text",
                            status.tone === "danger" && "bg-danger-soft text-danger-text",
                            status.tone === "pending" && "bg-fire-soft text-fire-text",
                            status.tone === "neutral" && "bg-surface-inset text-text-3",
                          )}>
                            {status.label}
                          </span>
                          {extra.externalUrl && (
                            <a
                              href={extra.externalUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="ml-auto inline-flex min-h-11 items-center gap-1 text-[12px] font-semibold text-brand underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15"
                            >
                              Открыть
                              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                            </a>
                          )}
                        </div>
                        {extra.message && (
                          <p className="mt-1 text-[12px] leading-relaxed text-text-3">{extra.message}</p>
                        )}
                        {retryable && (
                          <div className="mt-2 space-y-2">
                            {confirmationRequired && (
                              <label className="flex min-h-11 items-start gap-2 text-[12px] leading-relaxed text-text-2">
                                <input
                                  type="checkbox"
                                  checked={confirmedAbsent.has(extra.id)}
                                  onChange={(event) => {
                                    const checked = event.currentTarget.checked;
                                    setConfirmedAbsent((current) => {
                                      const next = new Set(current);
                                      if (checked) next.add(extra.id);
                                      else next.delete(extra.id);
                                      return next;
                                    });
                                  }}
                                  className="mt-0.5 h-5 w-5 shrink-0 accent-brand"
                                />
                                Я проверил(а) внешний канал: первого комментария нет
                              </label>
                            )}
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              loading={busyKey === `extra:${extra.id}`}
                              disabled={Boolean(busyKey) || (confirmationRequired && !confirmedAbsent.has(extra.id))}
                              onClick={() => void retry(extra)}
                            >
                              Повторить действие
                            </Button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              {destination.review && (
                <div className="mt-3 rounded-xs border border-line px-3 py-3">
                  <div className="flex items-start gap-2">
                    {destination.review.status === "completed" ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success-text" aria-hidden />
                    ) : destination.review.status === "due" || destination.review.canDecide ? (
                      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-fire-text" aria-hidden />
                    ) : (
                      <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-text-3" aria-hidden />
                    )}
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold text-text">Пересмотр актуальности</p>
                      <p className="mt-0.5 text-[12px] text-text-3">
                        {reviewDate(destination.review)} · {destination.review.timezone}
                      </p>
                    </div>
                  </div>
                  {destination.review.status === "completed" && destination.review.decision ? (
                    <p className="mt-2 text-[12px] font-medium text-success-text">
                      {DECISION_LABELS[destination.review.decision]}
                    </p>
                  ) : destination.review.canDecide ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="solid"
                        size="sm"
                        loading={busyKey === `review:${destination.review.id}:keep`}
                        disabled={Boolean(busyKey)}
                        onClick={() => void decide(destination.review!, "keep")}
                      >
                        Оставить
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        loading={busyKey === `review:${destination.review.id}:update`}
                        disabled={Boolean(busyKey)}
                        onClick={() => void decide(destination.review!, "update")}
                      >
                        Обновить текст
                      </Button>
                      {destination.review.canUnpin && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          loading={busyKey === `review:${destination.review.id}:unpin`}
                          disabled={Boolean(busyKey)}
                          onClick={() => void decide(destination.review!, "unpin")}
                        >
                          Открепить
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        loading={busyKey === `review:${destination.review.id}:remove_manually`}
                        disabled={Boolean(busyKey)}
                        onClick={() => void decide(destination.review!, "remove_manually")}
                      >
                        Снять вручную
                      </Button>
                    </div>
                  ) : destination.review.status === "due" ? (
                    <p className="mt-2 text-[12px] text-text-2">
                      Решение доступно назначенному ответственному и издателю проекта.
                    </p>
                  ) : (
                    <p className="mt-2 text-[12px] text-text-3">
                      {destination.review.reminderStatus === "failed"
                        ? "Уведомление в Telegram не доставлено. Задача пересмотра остаётся доступна здесь."
                        : destination.review.reminderStatus === "sent"
                          ? "Ответственный получил напоминание."
                          : "Напомним ответственному в назначенное время."}
                    </p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && destinations != null && <p role="alert" className="mt-3 text-[13px] font-medium text-danger-text">{error}</p>}
      <p role="status" aria-live="polite" className="mt-2 min-h-5 text-[13px] text-success-text">{message}</p>
    </section>
  );
}
