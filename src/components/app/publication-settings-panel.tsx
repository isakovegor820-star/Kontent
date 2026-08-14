"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { CalendarClock, MessageSquareText, Pin, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import type { ServerDraft } from "@/lib/draft-types";
import {
  buildPublicationSettingsPreview,
  parsePublicationBlocksResponse,
  parsePublicationPreferencesResponse,
  publicationSettingCapability,
  publicationSettingsErrorMessage,
  type ClientPublicationBlock,
  type ClientPublicationPreferences,
  type PublicationSettingsPreview,
} from "@/lib/publication-settings-client";
import {
  inspectLocalSchedule,
  localScheduleFieldsForInstant,
  resolveLocalSchedule,
  type ScheduleDisambiguation,
} from "@/lib/timezone-schedule";
import { cn } from "@/lib/utils";

type ProjectMember = { userId: number; label: string };

const BLOCK_LABELS: Record<ClientPublicationBlock["kind"], string> = {
  author_signature: "Подпись автора",
  contacts: "Контакты",
  disclaimer: "Оговорка",
  cta: "Призыв к действию",
  sources: "Источники",
  first_comment: "Первый комментарий",
};

const PROVIDER_LABELS: Record<string, string> = { tg: "Telegram", vk: "VK" };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseMembers(value: unknown) {
  const body = record(value);
  if (body?.ok !== true || !Array.isArray(body.members)) return null;
  const members: ProjectMember[] = [];
  for (const raw of body.members) {
    const item = record(raw);
    const userId = Number(item?.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) return null;
    const label = typeof item?.name === "string" && item.name.trim()
      ? item.name.trim()
      : typeof item?.email === "string" && item.email.trim()
        ? item.email.trim()
        : `Участник ${userId}`;
    members.push({ userId, label });
  }
  return members;
}

function localReviewValue(iso: string | null, timezone: string) {
  if (!iso) return "";
  try {
    const fields = localScheduleFieldsForInstant(iso, timezone);
    return `${fields.localDate}T${fields.localTime}`;
  } catch {
    return "";
  }
}

function serialize(preferences: ClientPublicationPreferences) {
  return JSON.stringify({
    selectedBlockIds: preferences.selectedBlockIds,
    firstCommentFallback: preferences.firstCommentFallback,
    commentsMode: preferences.commentsMode,
    pinAfterPublish: preferences.pinAfterPublish,
    reviewAt: preferences.reviewAt,
    reviewResponsibleUserId: preferences.reviewResponsibleUserId,
  });
}

export function PublicationSettingsPanel({
  draftId,
  projectId,
  timezone,
  providerIds,
  disabled = false,
  onSaveDraft,
  onDraftVersionChange,
  onPreviewChange,
}: {
  draftId: number | null;
  projectId: number | null;
  timezone: string;
  providerIds: readonly string[];
  disabled?: boolean;
  onSaveDraft: () => Promise<ServerDraft | null>;
  onDraftVersionChange: (version: number) => void;
  onPreviewChange: (preview: PublicationSettingsPreview | null) => void;
}) {
  const errorId = useId();
  const statusId = useId();
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [blocks, setBlocks] = useState<ClientPublicationBlock[]>([]);
  const [preferences, setPreferences] = useState<ClientPublicationPreferences | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [reviewLocal, setReviewLocal] = useState("");
  const [reviewDisambiguation, setReviewDisambiguation] = useState<ScheduleDisambiguation>("reject");

  useEffect(() => {
    if (draftId == null || projectId == null) {
      let cancelled = false;
      queueMicrotask(() => {
        if (cancelled) return;
        setPreferences(null);
        setBlocks([]);
        setMembers([]);
        setError(null);
        setMessage(null);
        setSavedSnapshot("");
      });
      return () => {
        cancelled = true;
      };
    }
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setLoading(true);
      setError(null);
      setMessage(null);
    });
    void Promise.all([
      fetch("/api/publication-blocks", { cache: "no-store", signal: controller.signal }),
      fetch(`/api/drafts/${draftId}/publication-preferences`, { cache: "no-store", signal: controller.signal }),
      fetch(`/api/projects/${projectId}/members`, { cache: "no-store", signal: controller.signal }),
    ]).then(async ([blocksResponse, preferencesResponse, membersResponse]) => {
      const [blocksBody, preferencesBody, membersBody] = await Promise.all([
        blocksResponse.json().catch(() => null),
        preferencesResponse.json().catch(() => null),
        membersResponse.json().catch(() => null),
      ]);
      const parsedBlocks = blocksResponse.ok ? parsePublicationBlocksResponse(blocksBody) : null;
      const parsedPreferences = preferencesResponse.ok
        ? parsePublicationPreferencesResponse(preferencesBody)
        : null;
      const parsedMembers = membersResponse.ok ? parseMembers(membersBody) : null;
      if (!parsedBlocks || !parsedPreferences || !parsedMembers) {
        throw new Error("publication_settings_unavailable");
      }
      setBlocks(parsedBlocks);
      setPreferences(parsedPreferences);
      setMembers(parsedMembers);
      setReviewLocal(localReviewValue(parsedPreferences.reviewAt, timezone));
      setReviewDisambiguation("reject");
      setSavedSnapshot(serialize(parsedPreferences));
    }).catch((reason) => {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError("Настройки публикации не загрузились. Текст черновика не затронут.");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [draftId, projectId, reloadKey, timezone]);

  const preview = useMemo(
    () => preferences ? buildPublicationSettingsPreview(blocks, preferences) : null,
    [blocks, preferences],
  );
  useEffect(() => onPreviewChange(preview), [onPreviewChange, preview]);
  useEffect(() => () => onPreviewChange(null), [onPreviewChange]);

  const dirty = preferences != null && serialize(preferences) !== savedSnapshot;
  const firstCommentCapability = publicationSettingCapability(providerIds, "firstComment");
  const pinCapability = publicationSettingCapability(providerIds, "pin");
  const commentsCapability = publicationSettingCapability(providerIds, "commentToggle");
  const firstCommentSelected = Boolean(preview?.firstCommentBlock);
  const reviewInspection = useMemo(() => {
    const [localDate = "", localTime = ""] = reviewLocal.split("T");
    return reviewLocal
      ? inspectLocalSchedule({ localDate, localTime, timezone })
      : null;
  }, [reviewLocal, timezone]);

  const update = (patch: Partial<ClientPublicationPreferences>) => {
    setPreferences((current) => current ? { ...current, ...patch } : current);
    setMessage(null);
    setError(null);
  };

  const toggleBlock = (block: ClientPublicationBlock, checked: boolean) => {
    if (!preferences) return;
    let ids = preferences.selectedBlockIds.filter((id) => id !== block.id);
    if (checked) {
      if (block.kind === "first_comment") {
        const firstCommentIds = new Set(blocks.filter((item) => item.kind === "first_comment").map((item) => item.id));
        ids = ids.filter((id) => !firstCommentIds.has(id));
      }
      ids.push(block.id);
    }
    update({ selectedBlockIds: ids });
  };

  const save = async () => {
    if (!preferences || saving || disabled) return;
    let reviewAt: string | null = null;
    if (reviewLocal) {
      const [localDate = "", localTime = ""] = reviewLocal.split("T");
      if (reviewInspection?.kind === "ambiguous" && reviewDisambiguation === "reject") {
        setError("Выберите первый или второй вариант повторяющегося времени.");
        return;
      }
      try {
        reviewAt = resolveLocalSchedule({
          localDate,
          localTime,
          timezone,
          disambiguation: reviewDisambiguation,
        }).scheduledAt;
      } catch {
        setError("Выберите существующие дату и время пересмотра.");
        return;
      }
      if (preferences.reviewResponsibleUserId == null) {
        setError("Выберите ответственного за пересмотр.");
        return;
      }
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const draft = await onSaveDraft();
      if (!draft || draft.id !== preferences.draftId) {
        setError("Сначала сохраните текущий текст. Настройки публикации пока не изменены.");
        return;
      }
      const response = await fetch(`/api/drafts/${preferences.draftId}/publication-preferences`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: preferences.version,
          selectedBlockIds: preferences.selectedBlockIds,
          firstCommentFallback: preferences.firstCommentFallback,
          commentsMode: preferences.commentsMode,
          pinAfterPublish: preferences.pinAfterPublish,
          reviewAt,
          reviewResponsibleUserId: reviewAt ? preferences.reviewResponsibleUserId : null,
        }),
      });
      const body = await response.json().catch(() => null);
      const saved = response.ok ? parsePublicationPreferencesResponse(body) : null;
      if (!saved) throw body;
      setPreferences(saved);
      setReviewLocal(localReviewValue(saved.reviewAt, timezone));
      setSavedSnapshot(serialize(saved));
      if (saved.draftVersion) onDraftVersionChange(saved.draftVersion);
      setMessage("Настройки публикации сохранены в новой версии черновика.");
    } catch (reason) {
      setError(publicationSettingsErrorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className="group rounded-sm border border-line bg-surface-2 px-4 open:pb-4">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 py-3 text-[14px] font-semibold text-text focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-2">
          <MessageSquareText className="h-4 w-4 shrink-0 text-text-3" aria-hidden />
          <span>Подписи и публикация</span>
        </span>
        <span className="text-right text-[12px] font-medium text-text-3">
          {preview?.selectedBlocks.length
            ? `${preview.selectedBlocks.length} блоков`
            : "без дополнительных блоков"}
        </span>
      </summary>

      {draftId == null ? (
        <div className="space-y-3 border-t border-line pt-4">
          <p className="max-w-[60ch] text-[13px] leading-relaxed text-text-3">
            Сначала сохраните черновик. После этого можно выбрать подпись, первый комментарий,
            закрепление и дату пересмотра — текст на экране не пропадёт.
          </p>
          <Button type="button" variant="primary" onClick={() => void onSaveDraft()} disabled={disabled}>
            Сохранить черновик
          </Button>
        </div>
      ) : loading ? (
        <p role="status" className="border-t border-line pt-4 text-[13px] text-text-3">
          Загружаем настройки публикации…
        </p>
      ) : !preferences ? (
        <div className="space-y-3 border-t border-line pt-4">
          <p role="alert" className="text-[13px] text-danger-text">{error}</p>
          <Button type="button" variant="outline" onClick={() => setReloadKey((key) => key + 1)}>
            <RotateCcw className="h-4 w-4" aria-hidden />
            Повторить загрузку
          </Button>
        </div>
      ) : (
        <div className="space-y-5 border-t border-line pt-4" aria-describedby={error ? errorId : undefined}>
          <fieldset disabled={saving || disabled}>
            <legend className="text-[13px] font-semibold text-text-2">Добавить к публикации</legend>
            {blocks.length === 0 ? (
              <p className="mt-2 text-[13px] leading-relaxed text-text-3">
                В проекте пока нет готовых блоков. Создайте подпись или комментарий в настройках постов.
              </p>
            ) : (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {blocks.map((block) => {
                  const checked = preferences.selectedBlockIds.includes(block.id);
                  return (
                    <label
                      key={block.id}
                      className={cn(
                        "flex min-h-11 items-start gap-3 rounded-xs border px-3 py-2.5",
                        checked ? "border-brand/35 bg-info-soft" : "border-line bg-surface",
                        !block.enabled && !checked && "opacity-55",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!block.enabled && !checked}
                        onChange={(event) => toggleBlock(block, event.target.checked)}
                        className="mt-0.5 h-5 w-5 shrink-0 accent-brand"
                      />
                      <span className="min-w-0">
                        <span className="block text-[13px] font-semibold text-text">{block.name}</span>
                        <span className="mt-0.5 block text-[12px] leading-relaxed text-text-3">
                          {BLOCK_LABELS[block.kind]}{!block.enabled ? " · отключён в проекте" : ""}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>

          {firstCommentSelected && firstCommentCapability.unsupported.length > 0 && (
            <label className="block text-[13px] font-semibold text-text-2">
              Если первый комментарий недоступен
              <select
                value={preferences.firstCommentFallback}
                disabled={saving || disabled}
                onChange={(event) => update({
                  firstCommentFallback: event.target.value as ClientPublicationPreferences["firstCommentFallback"],
                })}
                className="mt-2 min-h-11 w-full rounded-xs border border-line-strong bg-surface px-3 text-[14px] text-text focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15"
              >
                <option value="append_to_post">Добавить в конец поста</option>
                <option value="skip">Не публиковать этот блок</option>
              </select>
            </label>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-[13px] font-semibold text-text-2">
              Комментарии к посту
              <select
                value={preferences.commentsMode}
                disabled={saving || disabled || !commentsCapability.available}
                onChange={(event) => update({
                  commentsMode: event.target.value as ClientPublicationPreferences["commentsMode"],
                })}
                className="mt-2 min-h-11 w-full rounded-xs border border-line-strong bg-surface px-3 text-[14px] text-text focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 disabled:opacity-55"
              >
                <option value="provider_default">Как настроено в канале</option>
                <option value="enabled">Разрешить</option>
                <option value="disabled">Отключить</option>
              </select>
              <span className="mt-1.5 block text-[12px] font-normal leading-relaxed text-text-3">
                {commentsCapability.available
                  ? commentsCapability.partial
                    ? `Сработает только для: ${commentsCapability.supported.map((id) => PROVIDER_LABELS[id] || id).join(", ")}.`
                    : "Площадка поддерживает эту настройку."
                  : "Выбранные площадки не позволяют менять комментарии через Аврору."}
              </span>
            </label>

            <label className={cn(
              "flex min-h-11 items-start gap-3 rounded-xs border border-line bg-surface px-3 py-3",
              !pinCapability.available && "opacity-55",
            )}>
              <input
                type="checkbox"
                checked={preferences.pinAfterPublish}
                disabled={saving || disabled || !pinCapability.available}
                onChange={(event) => update({ pinAfterPublish: event.target.checked })}
                className="mt-0.5 h-5 w-5 shrink-0 accent-brand"
              />
              <span>
                <span className="flex items-center gap-1.5 text-[13px] font-semibold text-text">
                  <Pin className="h-4 w-4" aria-hidden />
                  Закрепить после публикации
                </span>
                <span className="mt-1 block text-[12px] font-normal leading-relaxed text-text-3">
                  {pinCapability.available
                    ? pinCapability.partial
                      ? `Только для: ${pinCapability.supported.map((id) => PROVIDER_LABELS[id] || id).join(", ")}.`
                      : "Выполним после подтверждённой публикации."
                    : "Недоступно для выбранных площадок."}
                </span>
              </span>
            </label>
          </div>

          <fieldset className="space-y-3">
            <legend className="flex items-center gap-2 text-[13px] font-semibold text-text-2">
              <CalendarClock className="h-4 w-4" aria-hidden />
              Пересмотр актуальности
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-[12px] font-medium text-text-3">
                Дата и время
                <Input
                  type="datetime-local"
                  value={reviewLocal}
                  disabled={saving || disabled}
                  onChange={(event) => {
                    setReviewLocal(event.target.value);
                    setReviewDisambiguation("reject");
                    update({
                      reviewAt: event.target.value || null,
                      reviewResponsibleUserId: event.target.value
                        ? preferences.reviewResponsibleUserId
                        : null,
                    });
                  }}
                  className="mt-1 nums"
                />
                <span className="mt-1 block font-normal">Часовой пояс: {timezone}</span>
              </label>
              <label className="text-[12px] font-medium text-text-3">
                Ответственный
                <select
                  value={preferences.reviewResponsibleUserId ?? ""}
                  disabled={saving || disabled || !reviewLocal}
                  onChange={(event) => update({
                    reviewResponsibleUserId: event.target.value ? Number(event.target.value) : null,
                  })}
                  className="mt-1 min-h-11 w-full rounded-xs border border-line-strong bg-surface px-3 text-[14px] text-text focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 disabled:opacity-55"
                >
                  <option value="">Выберите участника</option>
                  {members.map((member) => (
                    <option key={member.userId} value={member.userId}>{member.label}</option>
                  ))}
                </select>
              </label>
            </div>
            {reviewInspection?.kind === "nonexistent" && (
              <p role="alert" className="text-[12px] font-medium text-danger-text">
                Этого времени нет из-за перевода часов. Выберите другое.
              </p>
            )}
            {reviewInspection?.kind === "ambiguous" && (
              <fieldset className="rounded-xs border border-fire/30 bg-fire-soft p-3">
                <legend className="px-1 text-[12px] font-semibold text-text">
                  Время повторяется — какой вариант использовать?
                </legend>
                <div className="mt-2 flex flex-wrap gap-3">
                  {(["earlier", "later"] as const).map((value, index) => (
                    <label key={value} className="flex min-h-11 items-center gap-2 text-[13px] text-text">
                      <input
                        type="radio"
                        name={`review-disambiguation-${statusId}`}
                        checked={reviewDisambiguation === value}
                        onChange={() => setReviewDisambiguation(value)}
                        className="h-5 w-5 accent-brand"
                      />
                      {index === 0 ? "Первый вариант" : "Второй вариант"}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
          </fieldset>

          {error && <p id={errorId} role="alert" className="text-[13px] font-medium text-danger-text">{error}</p>}
          <p id={statusId} role="status" aria-live="polite" className="min-h-5 text-[13px] text-success-text">
            {message}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="solid" loading={saving} disabled={!dirty || disabled} onClick={() => void save()}>
              Сохранить настройки
            </Button>
            {dirty && <span className="text-[12px] text-text-3">Есть несохранённые изменения</span>}
          </div>
        </div>
      )}
    </details>
  );
}
