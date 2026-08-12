"use client";

import { useEffect, useId, useState } from "react";
import { FileText, Pencil, Plus, RotateCcw } from "lucide-react";

import { useProjects } from "@/components/app/project-provider";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/primitives";
import {
  parsePublicationBlock,
  parsePublicationBlocksResponse,
  publicationSettingsErrorMessage,
  type ClientPublicationBlock,
  type PublicationBlockKind,
} from "@/lib/publication-settings-client";
import { cn } from "@/lib/utils";

const KIND_OPTIONS: { value: PublicationBlockKind; label: string }[] = [
  { value: "author_signature", label: "Подпись автора" },
  { value: "contacts", label: "Контакты" },
  { value: "disclaimer", label: "Оговорка" },
  { value: "cta", label: "Призыв к действию" },
  { value: "sources", label: "Источники" },
  { value: "first_comment", label: "Первый комментарий" },
];

type FormState = {
  kind: PublicationBlockKind;
  name: string;
  text: string;
};

const EMPTY_FORM: FormState = { kind: "author_signature", name: "", text: "" };

function blockLabel(kind: PublicationBlockKind) {
  return KIND_OPTIONS.find((option) => option.value === kind)?.label || kind;
}

export function PublicationBlocksSection() {
  const projects = useProjects();
  const statusId = useId();
  const errorId = useId();
  const kindId = useId();
  const nameId = useId();
  const textId = useId();
  const textCountId = useId();
  const [blocks, setBlocks] = useState<ClientPublicationBlock[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const current = projects.current;
  const canManage = current?.role === "owner";

  useEffect(() => {
    if (!current) {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) setBlocks([]);
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
    });
    void fetch("/api/publication-blocks", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        const parsed = response.ok ? parsePublicationBlocksResponse(body) : null;
        if (!parsed) throw body;
        setBlocks(parsed);
      })
      .catch((reason) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError("Блоки публикации не загрузились. Другие настройки проекта не затронуты.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [current, reloadKey]);

  const beginCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setCreating(true);
    setError(null);
    setMessage(null);
  };

  const beginEdit = (block: ClientPublicationBlock) => {
    setCreating(false);
    setEditingId(block.id);
    setForm({ kind: block.kind, name: block.name, text: block.text });
    setError(null);
    setMessage(null);
  };

  const cancelForm = () => {
    setCreating(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError(null);
  };

  const save = async () => {
    if (busy || !canManage) return;
    const name = form.name.trim();
    const text = form.text.trim();
    if (!name || !text) {
      setError("Заполните название и текст блока.");
      return;
    }
    const editing = editingId == null ? null : blocks.find((block) => block.id === editingId);
    if (editingId != null && !editing) {
      setError("Блок уже изменился. Обновите список и повторите.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(editing ? `/api/publication-blocks/${editing.id}` : "/api/publication-blocks", {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(editing
          ? {
              kind: form.kind,
              name,
              body: text,
              expectedVersion: editing.version,
              enabled: editing.enabled,
            }
          : { kind: form.kind, name, body: text }),
      });
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      const saved = response.ok ? parsePublicationBlock(body?.block) : null;
      if (!saved) throw body;
      setBlocks((currentBlocks) => editing
        ? currentBlocks.map((block) => block.id === saved.id ? saved : block)
        : [...currentBlocks, saved]);
      setMessage(editing ? "Блок обновлён." : "Блок создан и доступен в Композиторе.");
      cancelForm();
    } catch (reason) {
      setError(publicationSettingsErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = async (block: ClientPublicationBlock, enabled: boolean) => {
    if (busy || !canManage) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/publication-blocks/${block.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: block.kind,
          name: block.name,
          body: block.text,
          expectedVersion: block.version,
          enabled,
        }),
      });
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      const saved = response.ok ? parsePublicationBlock(body?.block) : null;
      if (!saved) throw body;
      setBlocks((currentBlocks) => currentBlocks.map((item) => item.id === saved.id ? saved : item));
      setMessage(enabled ? "Блок снова доступен в Композиторе." : "Блок отключён для новых публикаций.");
    } catch (reason) {
      setError(publicationSettingsErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="publication-blocks" className="mb-5 rounded-md border border-line bg-surface p-4 shadow-soft sm:p-5" aria-labelledby="publication-blocks-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-[64ch]">
          <h2 id="publication-blocks-title" className="flex items-center gap-2 text-[17px] font-extrabold tracking-tight text-text">
            <FileText className="h-5 w-5 text-brand" aria-hidden />
            Блоки публикации
          </h2>
          <p className="mt-1 text-[13px] leading-relaxed text-text-3">
            Подготовьте подписи, контакты, оговорки и первый комментарий один раз. В Композиторе их можно включать отдельно для каждого поста.
          </p>
        </div>
        {canManage && !creating && editingId == null && (
          <Button type="button" variant="outline" size="sm" onClick={beginCreate}>
            <Plus className="h-4 w-4" aria-hidden />
            Добавить блок
          </Button>
        )}
      </div>

      {!current ? (
        <p className="mt-4 text-[13px] text-text-3">Выберите проект, чтобы увидеть его блоки.</p>
      ) : loading ? (
        <p role="status" className="mt-4 text-[13px] text-text-3">Загружаем блоки…</p>
      ) : error && blocks.length === 0 ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <p id={errorId} role="alert" className="text-[13px] text-danger-text">{error}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => setReloadKey((key) => key + 1)}>
            <RotateCcw className="h-4 w-4" aria-hidden />
            Повторить
          </Button>
        </div>
      ) : (
        <>
          {(creating || editingId != null) && (
            <form
              className="mt-4 space-y-3 border-t border-line pt-4"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
              aria-describedby={error ? errorId : undefined}
            >
              <div className="grid gap-3 sm:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
                <div>
                  <label htmlFor={kindId} className="text-[13px] font-semibold text-text-2">Тип блока</label>
                  <select
                    id={kindId}
                    value={form.kind}
                    disabled={busy}
                    onChange={(event) => {
                      const kind = event.currentTarget.value as PublicationBlockKind;
                      setForm((currentForm) => ({ ...currentForm, kind }));
                    }}
                    className="mt-1 min-h-11 w-full rounded-xs border border-line-strong bg-surface px-3 text-[14px] text-text focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15"
                  >
                    {KIND_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor={nameId} className="text-[13px] font-semibold text-text-2">Название</label>
                  <Input
                    id={nameId}
                    value={form.name}
                    disabled={busy}
                    required
                    maxLength={120}
                    onChange={(event) => {
                      const name = event.currentTarget.value;
                      setForm((currentForm) => ({ ...currentForm, name }));
                    }}
                    placeholder="Например: Подпись управляющего партнёра"
                    className="mt-1"
                  />
                </div>
              </div>
              <div>
                <label htmlFor={textId} className="block text-[13px] font-semibold text-text-2">Текст блока</label>
                <Textarea
                  id={textId}
                  value={form.text}
                  disabled={busy}
                  required
                  aria-describedby={textCountId}
                  maxLength={2_000}
                  rows={4}
                  onChange={(event) => {
                    const text = event.currentTarget.value;
                    setForm((currentForm) => ({ ...currentForm, text }));
                  }}
                  placeholder="Точный текст, который должен попасть в публикацию"
                  className="mt-1"
                />
                <span id={textCountId} className="mt-1 block text-right text-[11px] font-normal text-text-3 nums">
                  {form.text.length}/2000
                </span>
              </div>
              {error && <p id={errorId} role="alert" className="text-[13px] font-medium text-danger-text">{error}</p>}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="solid" loading={busy}>
                  {editingId == null ? "Создать блок" : "Сохранить блок"}
                </Button>
                <Button type="button" variant="ghost" onClick={cancelForm} disabled={busy}>Отменить</Button>
              </div>
            </form>
          )}

          {blocks.length === 0 && !creating ? (
            <div className="mt-4 border-t border-line pt-4">
              <p className="text-[13px] leading-relaxed text-text-3">
                Блоков пока нет. Начните с подписи автора или первого комментария.
              </p>
            </div>
          ) : (
            <ul className="mt-4 divide-y divide-line border-y border-line">
              {blocks.map((block) => (
                <li key={block.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-start">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[14px] font-semibold text-text">{block.name}</p>
                      <span className={cn(
                        "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                        block.enabled ? "bg-success-soft text-success-text" : "bg-surface-inset text-text-3",
                      )}>
                        {block.enabled ? "Активен" : "Отключён"}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[12px] text-text-3">{blockLabel(block.kind)}</p>
                    <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-[13px] leading-relaxed text-text-2">{block.text}</p>
                  </div>
                  {canManage && (
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Button type="button" variant="ghost" size="sm" onClick={() => beginEdit(block)} disabled={busy}>
                        <Pencil className="h-4 w-4" aria-hidden />
                        Изменить
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void setEnabled(block, !block.enabled)}
                        disabled={busy}
                      >
                        {block.enabled ? "Отключить" : "Включить"}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!canManage && (
            <p className="mt-3 text-[12px] leading-relaxed text-text-3">
              Изменять общие блоки может владелец проекта. Выбирать их для своих публикаций можно в Композиторе.
            </p>
          )}
        </>
      )}

      {error && blocks.length > 0 && !creating && editingId == null && (
        <p id={errorId} role="alert" className="mt-3 text-[13px] text-danger-text">{error}</p>
      )}
      <p id={statusId} role="status" aria-live="polite" className="mt-2 min-h-5 text-[13px] text-success-text">
        {message}
      </p>
    </section>
  );
}
