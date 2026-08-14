"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Clock3,
  MessageSquareText,
  RefreshCw,
  Send,
  Undo2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge, Textarea } from "@/components/ui/primitives";
import type { DraftSaveState, ServerDraft } from "@/lib/draft-types";
import {
  addEditorialComment,
  approvePersonalDraftForPublication,
  decideEditorialReview,
  editorialErrorMessage,
  editorialRoleCapabilities,
  loadEditorialSnapshot,
  submitEditorialReview,
  type ClientEditorialSnapshot,
  type ClientEditorialState,
} from "@/lib/editorial-client";
import type { ProjectRole } from "@/lib/project-permissions";
import { cn } from "@/lib/utils";

type BusyAction = "load" | "save" | "submit" | "confirm" | "comment" | "approve" | "request_changes" | null;

const STATE_PRESENTATION: Record<ClientEditorialState, {
  label: string;
  description: string;
  tone: "neutral" | "brand" | "fire" | "success";
}> = {
  draft: {
    label: "Черновик",
    description: "Материал можно отправить на согласование после сохранения текущей версии.",
    tone: "neutral",
  },
  in_review: {
    label: "На согласовании",
    description: "Согласующий проверяет именно эту сохранённую версию материала.",
    tone: "brand",
  },
  changes_requested: {
    label: "Нужны правки",
    description: "Исправьте материал, сохраните новую версию и отправьте её повторно.",
    tone: "fire",
  },
  approved: {
    label: "Согласован",
    description: "Публикация разрешена только для этой версии. Смысловая правка снимет согласование.",
    tone: "success",
  },
};

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function saveStateMessage(state: DraftSaveState): string | null {
  if (state === "saving") return "Сохраняем текущую версию…";
  if (state === "pending" || state === "idle") return "Есть несохранённые изменения.";
  if (state === "offline") return "Текущая версия ещё не сохранена: нет связи с сервером.";
  if (state === "conflict") return "Черновик изменён в другой вкладке. Откройте актуальную версию из календаря.";
  if (state === "failed") return "Текущую версию не удалось сохранить.";
  return null;
}

export function EditorialReviewPanel({
  projectId,
  draftId,
  role,
  personalProject = false,
  draftSaveState,
  disabled = false,
  onSaveDraft,
  onStateChange,
}: {
  projectId: number | null;
  draftId: number | null;
  role: ProjectRole | null | undefined;
  personalProject?: boolean;
  draftSaveState: DraftSaveState;
  disabled?: boolean;
  onSaveDraft: () => Promise<ServerDraft | null>;
  onStateChange?: (state: ClientEditorialState | null) => void;
}) {
  const descriptionId = useId();
  const noteId = useId();
  const noteErrorId = useId();
  const commentId = useId();
  const commentErrorId = useId();
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const previousSaveStateRef = useRef(draftSaveState);
  const snapshotRequestRef = useRef(0);
  const [snapshot, setSnapshot] = useState<ClientEditorialSnapshot | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [comment, setComment] = useState("");
  const [decisionNote, setDecisionNote] = useState("");
  const [noteInvalid, setNoteInvalid] = useState(false);
  const [commentInvalid, setCommentInvalid] = useState(false);
  const capabilities = useMemo(() => editorialRoleCapabilities(role), [role]);
  const setCurrentSnapshot = useCallback((value: ClientEditorialSnapshot | null) => {
    setSnapshot(value);
    onStateChange?.(value?.workflow.state ?? null);
  }, [onStateChange]);

  const load = useCallback(async (id: number, signal?: AbortSignal) => {
    const requestSequence = ++snapshotRequestRef.current;
    setBusy((current) => current ?? "load");
    setError("");
    try {
      const result = await loadEditorialSnapshot(id, signal);
      if (!signal?.aborted && requestSequence === snapshotRequestRef.current) {
        setCurrentSnapshot(result);
      }
      return result;
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return null;
      if (!signal?.aborted) setError(editorialErrorMessage(loadError));
      return null;
    } finally {
      if (!signal?.aborted && requestSequence === snapshotRequestRef.current) {
        setBusy((current) => current === "load" ? null : current);
      }
    }
  }, [setCurrentSnapshot]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      setCurrentSnapshot(null);
      setError("");
      setMessage("");
      setComment("");
      setDecisionNote("");
      setNoteInvalid(false);
      setCommentInvalid(false);
      if (draftId != null && projectId != null) void load(draftId, controller.signal);
    });
    return () => controller.abort();
  }, [draftId, load, projectId, setCurrentSnapshot]);

  useEffect(() => {
    const previous = previousSaveStateRef.current;
    previousSaveStateRef.current = draftSaveState;
    // A content change creates a new immutable revision and can revoke an older
    // approval. Refresh once the server has acknowledged that new revision so the
    // panel never keeps showing «Согласован» for already changed text.
    if (
      draftSaveState === "saved"
      && previous !== "saved"
      && draftId != null
      && projectId != null
    ) {
      void load(draftId);
    }
  }, [draftId, draftSaveState, load, projectId]);

  const refreshAfter = useCallback(async (
    action: Exclude<BusyAction, "load" | "save" | null>,
    task: (current: ClientEditorialSnapshot) => Promise<void>,
    success: string,
  ): Promise<boolean> => {
    if (draftId == null || !snapshot || busy) return false;
    setBusy(action);
    setError("");
    setMessage("");
    // Invalidate a background snapshot started before this mutation. Its stale
    // response must never overwrite the durable state loaded after the decision.
    snapshotRequestRef.current += 1;
    try {
      await task(snapshot);
      const requestSequence = ++snapshotRequestRef.current;
      const fresh = await loadEditorialSnapshot(draftId);
      if (requestSequence === snapshotRequestRef.current) setCurrentSnapshot(fresh);
      setMessage(success);
      return true;
    } catch (actionError) {
      setError(editorialErrorMessage(actionError));
      if (["stale_revision", "stale_workflow", "stale_request", "review_open"].includes(
        actionError instanceof Error ? actionError.message : "",
      )) void load(draftId);
      return false;
    } finally {
      setBusy(null);
    }
  }, [busy, draftId, load, setCurrentSnapshot, snapshot]);

  const saveOnly = useCallback(async () => {
    if (busy || disabled) return;
    setBusy("save");
    setError("");
    setMessage("");
    try {
      const saved = await onSaveDraft();
      if (!saved) {
        setError("Черновик не сохранён. Исправьте отмеченные поля и повторите.");
        return;
      }
      setMessage("Черновик сохранён. Теперь его можно отправить на согласование.");
    } catch (saveError) {
      setError(editorialErrorMessage(saveError));
    } finally {
      setBusy(null);
    }
  }, [busy, disabled, onSaveDraft]);

  const submit = useCallback(async () => {
    if (draftId == null || !snapshot || busy || disabled) return;
    setBusy("submit");
    setError("");
    setMessage("");
    try {
      const saved = await onSaveDraft();
      if (!saved) {
        setError("Текущая версия не сохранена. Исправьте отмеченные поля и повторите.");
        return;
      }
      const current = await loadEditorialSnapshot(saved.id);
      await submitEditorialReview(saved.id, current);
      setCurrentSnapshot(await loadEditorialSnapshot(saved.id));
      setMessage("Материал отправлен на согласование.");
    } catch (submitError) {
      setError(editorialErrorMessage(submitError));
      void load(draftId);
    } finally {
      setBusy(null);
    }
  }, [busy, disabled, draftId, load, onSaveDraft, setCurrentSnapshot, snapshot]);

  const confirmPersonalPost = useCallback(async () => {
    if (!personalProject || role !== "owner" || busy || disabled) return;
    setBusy("confirm");
    setError("");
    setMessage("");
    try {
      const saved = await onSaveDraft();
      if (!saved) {
        setError("Пост не сохранён. Исправьте отмеченные поля и повторите.");
        return;
      }
      const current = await approvePersonalDraftForPublication(saved.id, saved.version);
      setCurrentSnapshot(current);
      setMessage("Пост подтверждён. Теперь выберите время и добавьте его в календарь.");
    } catch (confirmError) {
      setError(editorialErrorMessage(confirmError));
      if (draftId != null) void load(draftId);
    } finally {
      setBusy(null);
    }
  }, [busy, disabled, draftId, load, onSaveDraft, personalProject, role, setCurrentSnapshot]);

  const sendComment = useCallback(async () => {
    const body = comment.trim();
    if (!body || body.length > 4_000) {
      setCommentInvalid(true);
      requestAnimationFrame(() => commentRef.current?.focus());
      return;
    }
    setCommentInvalid(false);
    if (await refreshAfter("comment", (current) => addEditorialComment(draftId!, current, body), "Комментарий добавлен к этой версии.")) {
      setComment("");
    }
  }, [comment, draftId, refreshAfter]);

  const decide = useCallback(async (decision: "approve" | "request_changes") => {
    const note = decisionNote.trim();
    if (decision === "request_changes" && !note) {
      setNoteInvalid(true);
      requestAnimationFrame(() => noteRef.current?.focus());
      return;
    }
    setNoteInvalid(false);
    const completed = await refreshAfter(
      decision,
      (current) => decideEditorialReview(draftId!, current, decision, note || null),
      decision === "approve" ? "Версия согласована." : "Запрос правок отправлен автору.",
    );
    if (completed) setDecisionNote("");
  }, [decisionNote, draftId, refreshAfter]);

  const presentation = STATE_PRESENTATION[snapshot?.workflow.state ?? "draft"];
  const stateDescription = personalProject
    ? snapshot?.workflow.state === "approved"
      ? "Пост готов к добавлению в календарь. Если изменить текст, его нужно будет подтвердить снова."
      : snapshot?.workflow.state === "changes_requested"
        ? "Текст изменился. Сохраните и подтвердите готовую версию ещё раз."
        : snapshot?.workflow.state === "in_review"
          ? "Аврора фиксирует готовую версию поста…"
          : "Текст сохранён. Подтвердите готовую версию перед добавлением в календарь."
    : presentation.description;
  const saveWarning = saveStateMessage(draftSaveState);
  const exactVersionReady = draftSaveState === "saved";
  const openRequest = snapshot?.workflow.state === "in_review"
    && snapshot.request?.status === "open"
    && snapshot.request.revisionId === snapshot.currentRevision.id;
  const interactionDisabled = disabled || busy != null;

  return (
    <section aria-labelledby={`${descriptionId}-title`} aria-describedby={descriptionId} className="space-y-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 id={`${descriptionId}-title`} className="text-[15px] leading-snug font-semibold text-text">
            {personalProject ? "Готовность поста" : "Согласование материала"}
          </h2>
          <p id={descriptionId} className="mt-1 max-w-2xl text-[13px] leading-relaxed text-text-3 text-pretty">
            {personalProject
              ? "Подтвердите готовый текст одним действием. После смысловой правки подтверждение потребуется снова."
              : "Решения и комментарии привязаны к сохранённой версии. После смысловой правки материал нужно согласовать заново."}
          </p>
        </div>
        <Badge tone={presentation.tone}>{presentation.label}</Badge>
      </div>

      {draftId == null ? (
        <div className="rounded-sm bg-surface-inset p-4">
          <p className="max-w-2xl text-[13px] leading-relaxed text-text-2">
            {capabilities.readOnly
              ? "Сначала автор должен сохранить материал и отправить его на согласование. После одобрения здесь появится версия для публикации."
              : "Сохраните черновик на сервере, чтобы отправить его команде и не потерять историю решений."}
          </p>
          {personalProject && role === "owner" ? (
            <Button type="button" variant="solid" size="sm" className="mt-3" loading={busy === "confirm"} disabled={disabled} onClick={() => void confirmPersonalPost()}>
              <CheckCircle2 className="h-4 w-4" aria-hidden />
              Сохранить и подтвердить пост
            </Button>
          ) : capabilities.canSubmit && (
            <Button type="button" variant="primary" size="sm" className="mt-3" loading={busy === "save"} disabled={disabled} onClick={() => void saveOnly()}>
              <Send className="h-4 w-4" aria-hidden />
              Сохранить черновик
            </Button>
          )}
        </div>
      ) : busy === "load" && !snapshot ? (
        <p role="status" className="rounded-sm bg-surface-inset p-4 text-[13px] text-text-2">
          Загружаем согласование…
        </p>
      ) : snapshot ? (
        <>
          <div className={cn(
            "rounded-sm p-4",
            snapshot.workflow.state === "approved"
              ? "bg-success-soft text-success-text"
              : snapshot.workflow.state === "changes_requested"
                ? "bg-fire-soft text-fire-text"
                : snapshot.workflow.state === "in_review"
                  ? "bg-info-soft text-info-text"
                  : "bg-surface-inset text-text-2",
          )}>
            <p className="text-[13px] leading-relaxed font-medium">{stateDescription}</p>
            <p className="mt-1 text-[12px] leading-relaxed opacity-80">
              Версия {snapshot.currentRevision.draftVersion} · {snapshot.currentRevision.authorName} · {formatDate(snapshot.currentRevision.createdAt)}
            </p>
          </div>

          {saveWarning && (
            <p role={draftSaveState === "conflict" ? "alert" : "status"} className="flex items-start gap-2 text-[13px] leading-relaxed text-fire-text">
              <Clock3 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{saveWarning}</span>
            </p>
          )}

          {capabilities.readOnly && (
            <p className="rounded-sm bg-surface-inset p-3 text-[13px] leading-relaxed text-text-2">
              Публикатор видит историю и статус, но не отправляет материал и не принимает редакционные решения.
            </p>
          )}

          {personalProject && role === "owner" && snapshot.workflow.state !== "approved" && (
            <Button type="button" variant="solid" size="sm" loading={busy === "confirm"} disabled={interactionDisabled} onClick={() => void confirmPersonalPost()}>
              <CheckCircle2 className="h-4 w-4" aria-hidden />
              Подтвердить пост
            </Button>
          )}

          {!personalProject && capabilities.canSubmit && ["draft", "changes_requested"].includes(snapshot.workflow.state) && (
            <Button type="button" variant="solid" size="sm" loading={busy === "submit"} disabled={interactionDisabled} className="h-auto max-w-full whitespace-normal text-center" onClick={() => void submit()}>
              <Send className="h-4 w-4" aria-hidden />
              {snapshot.workflow.state === "changes_requested" ? "Сохранить и отправить повторно" : "Сохранить и отправить на согласование"}
            </Button>
          )}

          {!personalProject && capabilities.canReview && openRequest && (
            <fieldset className="space-y-3 rounded-sm border border-line bg-surface-2 p-4">
              <legend className="px-1 text-[13px] font-semibold text-text">Решение по текущей версии</legend>
              <label htmlFor={noteId} className="block text-[13px] font-semibold text-text-2">
                Комментарий к решению
              </label>
              <Textarea
                ref={noteRef}
                id={noteId}
                rows={3}
                value={decisionNote}
                maxLength={4_000}
                disabled={interactionDisabled}
                aria-invalid={noteInvalid || undefined}
                aria-describedby={noteInvalid ? noteErrorId : undefined}
                placeholder="Что проверить или исправить"
                onChange={(event) => {
                  setDecisionNote(event.target.value);
                  if (noteInvalid) setNoteInvalid(false);
                }}
              />
              {noteInvalid && (
                <p id={noteErrorId} role="alert" className="text-[13px] font-medium text-danger-text">
                  Опишите, что нужно исправить.
                </p>
              )}
              {!exactVersionReady && (
                <p className="text-[13px] leading-relaxed text-fire-text">
                  Дождитесь сохранения текущей версии перед решением.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="solid" size="sm" loading={busy === "approve"} disabled={interactionDisabled || !exactVersionReady} onClick={() => void decide("approve")}>
                  <CheckCircle2 className="h-4 w-4" aria-hidden />
                  Согласовать версию
                </Button>
                <Button type="button" variant="outline" size="sm" loading={busy === "request_changes"} disabled={interactionDisabled || !exactVersionReady} onClick={() => void decide("request_changes")}>
                  <Undo2 className="h-4 w-4" aria-hidden />
                  Запросить правки
                </Button>
              </div>
            </fieldset>
          )}

          {!personalProject && capabilities.canReview && (
            <form
              noValidate
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void sendComment();
              }}
            >
              <label htmlFor={commentId} className="block text-[13px] font-semibold text-text-2">
                Комментарий к версии
              </label>
              <Textarea
                ref={commentRef}
                id={commentId}
                rows={3}
                value={comment}
                maxLength={4_000}
                disabled={interactionDisabled}
                aria-invalid={commentInvalid || undefined}
                aria-describedby={commentInvalid ? commentErrorId : undefined}
                placeholder="Например: добавьте источник для вывода в третьем абзаце"
                onChange={(event) => {
                  setComment(event.target.value);
                  if (commentInvalid) setCommentInvalid(false);
                }}
              />
              {commentInvalid && (
                <p id={commentErrorId} role="alert" className="text-[13px] font-medium text-danger-text">
                  Введите комментарий длиной до 4 000 символов.
                </p>
              )}
              <Button type="submit" variant="soft" size="sm" loading={busy === "comment"} disabled={interactionDisabled || !exactVersionReady}>
                <MessageSquareText className="h-4 w-4" aria-hidden />
                Добавить комментарий
              </Button>
            </form>
          )}

          {!personalProject && <details className="group rounded-sm bg-surface-inset px-4 open:pb-4">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 py-3 text-[13px] font-semibold text-text focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 [&::-webkit-details-marker]:hidden">
              <span>История согласования</span>
              <span className="text-[12px] font-medium text-text-3">
                {snapshot.comments.length + snapshot.decisions.length} записей
              </span>
            </summary>
            {snapshot.comments.length === 0 && snapshot.decisions.length === 0 ? (
              <p className="text-[13px] leading-relaxed text-text-3">
                Пока нет комментариев и решений. Они появятся здесь после первой проверки.
              </p>
            ) : (
              <ol className="space-y-4" aria-label="Комментарии и решения">
                {[
                  ...snapshot.comments.map((item) => ({
                    id: `comment-${item.id}`,
                    at: item.createdAt,
                    title: `${item.authorName} · комментарий`,
                    body: item.body,
                    revisionId: item.revisionId,
                    tone: "text-text-2",
                  })),
                  ...snapshot.decisions.map((item) => ({
                    id: `decision-${item.id}`,
                    at: item.createdAt,
                    title: `${item.actorName} · ${item.decision === "approve" ? "решение: согласовано" : "решение: нужны правки"}`,
                    body: item.note,
                    revisionId: item.revisionId,
                    tone: item.decision === "approve" ? "text-success-text" : "text-fire-text",
                  })),
                ].sort((left, right) => Date.parse(right.at) - Date.parse(left.at)).map((item) => (
                  <li key={item.id} className="min-w-0">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <p className={cn("text-[13px] leading-relaxed font-semibold", item.tone)}>{item.title}</p>
                      <time dateTime={item.at} className="nums text-[12px] text-text-3">{formatDate(item.at)}</time>
                    </div>
                    <p className="mt-1 text-[12px] text-text-3">
                      {item.revisionId === snapshot.currentRevision.id ? "Текущая версия" : "Предыдущая версия"}
                    </p>
                    {item.body && <p className="mt-1 max-w-2xl whitespace-pre-wrap break-words text-[13px] leading-relaxed text-text-2">{item.body}</p>}
                  </li>
                ))}
              </ol>
            )}
          </details>}
        </>
      ) : null}

      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-sm bg-danger-soft p-3 text-[13px] leading-relaxed text-danger-text">
          <span className="min-w-0 flex-1">{error}</span>
          {draftId != null && (
            <Button type="button" variant="outline" size="sm" disabled={busy != null} onClick={() => void load(draftId)}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Обновить
            </Button>
          )}
        </div>
      )}
      <p role="status" aria-live="polite" aria-atomic="true" className="min-h-5 text-[13px] font-medium text-success-text">
        {message}
      </p>
    </section>
  );
}
