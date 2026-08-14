"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  BookOpenCheck,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";

import { useProjects } from "@/components/app/project-provider";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Badge, Card, Field, Input } from "@/components/ui/primitives";
import {
  brandDictionaryErrorMessage,
  loadBrandDictionary,
  type ClientBrandDictionary,
  type ClientBrandDictionaryEntry,
} from "@/lib/brand-dictionary-client";
import type { BrandDictionaryEntryKind } from "@/lib/legal-typographer";
import { plural } from "@/lib/utils";

type FormState = {
  kind: BrandDictionaryEntryKind;
  term: string;
  replacement: string;
  expansion: string;
  caseSensitive: boolean;
};

type Feedback = { kind: "success" | "error" | "info"; text: string } | null;

const EMPTY_FORM: FormState = {
  kind: "canonical",
  term: "",
  replacement: "",
  expansion: "",
  caseSensitive: false,
};

const KIND_COPY: Record<BrandDictionaryEntryKind, {
  label: string;
  description: string;
  tone: "brand" | "success" | "danger" | "neutral" | "fire";
}> = {
  canonical: {
    label: "Каноничное написание",
    description: "Заменяет вариант на единое написание бренда.",
    tone: "brand",
  },
  allowed: {
    label: "Разрешённый вариант",
    description: "Оставляет этот вариант без словарной замены.",
    tone: "success",
  },
  prohibited: {
    label: "Запрещённый вариант",
    description: "Требует явной проверки перед заменой или публикацией.",
    tone: "danger",
  },
  exception: {
    label: "Исключение",
    description: "Защищает точную фразу от всех автоматических правок.",
    tone: "neutral",
  },
  abbreviation: {
    label: "Аббревиатура",
    description: "Предлагает утверждённую краткую форму с расшифровкой.",
    tone: "fire",
  },
};

const SELECT_CLASS = [
  "min-h-12 w-full rounded-xs border border-line bg-surface px-4 text-base text-text sm:text-[15px]",
  "hover:border-line-strong focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/15",
  "disabled:cursor-not-allowed disabled:opacity-50",
].join(" ");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requestJson(url: string, init: RequestInit) {
  try {
    const response = await fetch(url, { cache: "no-store", ...init });
    const parsed = await response.json().catch(() => null);
    return { response, body: isRecord(parsed) ? parsed : null };
  } catch {
    return { response: null, body: null };
  }
}

function formForEntry(entry: ClientBrandDictionaryEntry): FormState {
  return {
    kind: entry.kind,
    term: entry.term,
    replacement: entry.replacement ?? "",
    expansion: entry.expansion ?? "",
    caseSensitive: entry.caseSensitive,
  };
}

function validateForm(form: FormState) {
  if (!form.term.trim()) return { field: "term" as const, message: "Укажи вариант, который нужно проверять." };
  if (form.term.trim().length > 240) return { field: "term" as const, message: "Сократи вариант до 240 символов." };
  if (
    form.kind !== "allowed"
    && form.kind !== "exception"
    && !form.replacement.trim()
  ) return { field: "replacement" as const, message: "Укажи утверждённую замену." };
  if (form.replacement.trim().length > 240) {
    return { field: "replacement" as const, message: "Сократи замену до 240 символов." };
  }
  if (form.expansion.trim().length > 500) {
    return { field: "expansion" as const, message: "Сократи расшифровку до 500 символов." };
  }
  return null;
}

export function BrandDictionarySection() {
  const projects = useProjects();
  const current = projects.current;
  const canManage = current?.role === "owner";
  const sectionTitleId = useId();
  const termMessageId = useId();
  const replacementMessageId = useId();
  const expansionMessageId = useId();
  const termRef = useRef<HTMLInputElement>(null);
  const requestSequence = useRef(0);

  const [dictionary, setDictionary] = useState<ClientBrandDictionary | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editing, setEditing] = useState<ClientBrandDictionaryEntry | null>(null);
  const [deleting, setDeleting] = useState<ClientBrandDictionaryEntry | null>(null);
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [fieldError, setFieldError] = useState<{ field: "term" | "replacement" | "expansion"; message: string } | null>(null);

  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setLoadError(false);
    try {
      const next = await loadBrandDictionary();
      if (sequence !== requestSequence.current) return;
      setDictionary(next);
    } catch {
      if (sequence !== requestSequence.current) return;
      setLoadError(true);
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, []);

  const currentProjectId = current?.id ?? null;
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      requestSequence.current += 1;
      setDictionary(null);
      setEditing(null);
      setDeleting(null);
      setForm(EMPTY_FORM);
      setFeedback(null);
      setFieldError(null);
      if (currentProjectId != null) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [currentProjectId, load]);

  const resetForm = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFieldError(null);
  };

  const startEdit = (entry: ClientBrandDictionaryEntry) => {
    setEditing(entry);
    setForm(formForEntry(entry));
    setFeedback(null);
    setFieldError(null);
    requestAnimationFrame(() => termRef.current?.focus());
  };

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!dictionary || !canManage || busy) return;
    const invalid = validateForm(form);
    if (invalid) {
      setFieldError(invalid);
      if (invalid.field === "term") termRef.current?.focus();
      return;
    }
    setBusy("save");
    setFeedback(null);
    setFieldError(null);
    const payload = {
      expectedDictionaryVersion: dictionary.version,
      ...(editing ? { expectedEntryVersion: editing.version } : {}),
      kind: form.kind,
      term: form.term.trim(),
      replacement: form.kind === "allowed" || form.kind === "exception"
        ? null
        : form.replacement.trim(),
      expansion: form.expansion.trim() || null,
      caseSensitive: form.caseSensitive,
    };
    const { response, body } = await requestJson(
      editing ? `/api/brand-dictionary/${editing.id}` : "/api/brand-dictionary",
      {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    if (!response?.ok || body?.ok !== true) {
      const code = typeof body?.error === "string" ? body.error : "network";
      setFeedback({ kind: "error", text: brandDictionaryErrorMessage(code) });
      setBusy(null);
      if (code === "version_conflict" || code === "entry_not_found") await load();
      return;
    }
    const savedEditing = editing != null;
    resetForm();
    setFeedback({
      kind: "success",
      text: savedEditing ? "Правило обновлено. Новая версия словаря уже действует." : "Правило добавлено в словарь проекта.",
    });
    await load();
    setBusy(null);
  };

  const remove = async () => {
    if (!dictionary || !deleting || !canManage || busy) return;
    setBusy("delete");
    setFeedback(null);
    const target = deleting;
    const { response, body } = await requestJson(`/api/brand-dictionary/${target.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedDictionaryVersion: dictionary.version,
        expectedEntryVersion: target.version,
      }),
    });
    if (!response?.ok || body?.ok !== true) {
      const code = typeof body?.error === "string" ? body.error : "network";
      setFeedback({ kind: "error", text: brandDictionaryErrorMessage(code) });
      setBusy(null);
      setDeleting(null);
      if (code === "version_conflict" || code === "entry_not_found") await load();
      return;
    }
    if (editing?.id === target.id) resetForm();
    setDeleting(null);
    setFeedback({ kind: "success", text: "Правило удалено. Новая версия словаря уже действует." });
    await load();
    setBusy(null);
  };

  const requiresReplacement = form.kind !== "allowed" && form.kind !== "exception";

  return (
    <section aria-labelledby={sectionTitleId} className="mb-5">
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-4 border-b border-line px-6 py-5 sm:flex-row sm:items-start sm:justify-between sm:px-7">
          <div className="flex min-w-0 items-start gap-3.5">
            <span aria-hidden className="grid h-10 w-10 shrink-0 place-items-center rounded-sm bg-surface-inset text-text-2">
              <BookOpenCheck className="h-5 w-5" strokeWidth={1.75} />
            </span>
            <div className="min-w-0">
              <h2 id={sectionTitleId} className="text-[17px] font-extrabold tracking-tight text-text">
                Словарь бренда
              </h2>
              <p className="mt-1 max-w-[68ch] text-[14px] leading-relaxed text-text-2">
                Закрепи каноничные названия, допустимые варианты, запреты, исключения и аббревиатуры для текущего проекта.
              </p>
            </div>
          </div>
          {dictionary && (
            <Badge tone="neutral" className="self-start tabular-nums">
              Версия {dictionary.version}
            </Badge>
          )}
        </div>

        <div className="space-y-7 px-6 py-6 sm:px-7 sm:py-7">
          <div className="min-h-6" aria-live="polite" aria-atomic="true">
            {feedback && (
              <p
                role={feedback.kind === "error" ? "alert" : "status"}
                className={feedback.kind === "error"
                  ? "flex items-start gap-2 text-[13px] font-medium leading-relaxed text-danger-text"
                  : feedback.kind === "success"
                    ? "text-[13px] font-medium leading-relaxed text-success-text"
                    : "text-[13px] leading-relaxed text-text-2"}
              >
                {feedback.kind === "error" && <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
                {feedback.text}
              </p>
            )}
          </div>

          {loading && !dictionary ? (
            <div role="status" aria-busy="true" className="space-y-3">
              <span className="sr-only">Загружаем словарь бренда</span>
              <div className="skeleton h-12 rounded-sm" aria-hidden />
              <div className="skeleton h-20 rounded-sm" aria-hidden />
            </div>
          ) : loadError || !dictionary ? (
            <div role="alert" className="rounded-sm border border-danger/30 bg-danger-soft p-4">
              <p className="flex items-start gap-2 text-[14px] font-semibold text-danger-text">
                <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
                Не удалось загрузить словарь проекта
              </p>
              <p className="mt-1.5 text-[13px] leading-relaxed text-text-2">
                Сохранённые правила не показаны и не применяются в этой форме, пока связь не восстановится.
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => void load()} className="mt-3">
                <RefreshCw className="h-4 w-4" aria-hidden />
                Загрузить снова
              </Button>
            </div>
          ) : (
            <>
              {canManage ? (
                <form onSubmit={save} className="space-y-5 rounded-sm bg-surface-2 p-4 sm:p-5" aria-label={editing ? "Изменение правила словаря" : "Новое правило словаря"}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-[15px] font-bold text-text">
                        {editing ? "Изменить правило" : "Добавить правило"}
                      </h3>
                      <p className="mt-1 text-[13px] leading-relaxed text-text-3">
                        Изменение сразу создаёт новую версию словаря для следующих проверок.
                      </p>
                    </div>
                    {editing && (
                      <Button type="button" variant="ghost" size="sm" onClick={resetForm} disabled={busy != null}>
                        <X className="h-4 w-4" aria-hidden />
                        Отменить изменение
                      </Button>
                    )}
                  </div>

                  <div className="grid gap-4 lg:grid-cols-2">
                    <Field label="Тип правила" htmlFor="brand-dictionary-kind" required>
                      <select
                        id="brand-dictionary-kind"
                        required
                        value={form.kind}
                        disabled={busy != null}
                        className={SELECT_CLASS}
                        onChange={(event) => {
                          const kind = event.currentTarget.value as BrandDictionaryEntryKind;
                          setForm((currentForm) => ({
                            ...currentForm,
                            kind,
                            replacement: kind === "allowed" || kind === "exception" ? "" : currentForm.replacement,
                            expansion: kind === "abbreviation" ? currentForm.expansion : "",
                          }));
                          setFieldError(null);
                        }}
                      >
                        {(Object.keys(KIND_COPY) as BrandDictionaryEntryKind[]).map((kind) => (
                          <option key={kind} value={kind}>{KIND_COPY[kind].label}</option>
                        ))}
                      </select>
                    </Field>

                    <Field
                      label="Проверяемый вариант"
                      htmlFor="brand-dictionary-term"
                      required
                      error={fieldError?.field === "term" ? fieldError.message : undefined}
                      messageId={termMessageId}
                      hint="Например: legal tech"
                    >
                      <Input
                        ref={termRef}
                        id="brand-dictionary-term"
                        required
                        value={form.term}
                        disabled={busy != null}
                        maxLength={240}
                        aria-invalid={fieldError?.field === "term" || undefined}
                        aria-describedby={termMessageId}
                        onChange={(event) => {
                          const term = event.currentTarget.value;
                          setForm((currentForm) => ({ ...currentForm, term }));
                          setFieldError(null);
                        }}
                      />
                    </Field>
                  </div>

                  <p className="rounded-xs bg-surface-inset px-3 py-2 text-[13px] leading-relaxed text-text-2">
                    {KIND_COPY[form.kind].description}
                  </p>

                  {requiresReplacement && (
                    <div className="grid gap-4 lg:grid-cols-2">
                      <Field
                        label={form.kind === "abbreviation" ? "Утверждённая аббревиатура" : "Каноничная замена"}
                        htmlFor="brand-dictionary-replacement"
                        required
                        error={fieldError?.field === "replacement" ? fieldError.message : undefined}
                        messageId={replacementMessageId}
                        hint={form.kind === "abbreviation" ? "Например: КС РФ" : "Например: LegalTech"}
                      >
                        <Input
                          id="brand-dictionary-replacement"
                          required
                          value={form.replacement}
                          disabled={busy != null}
                          maxLength={240}
                          aria-invalid={fieldError?.field === "replacement" || undefined}
                          aria-describedby={replacementMessageId}
                          onChange={(event) => {
                            const replacement = event.currentTarget.value;
                            setForm((currentForm) => ({ ...currentForm, replacement }));
                            setFieldError(null);
                          }}
                        />
                      </Field>
                      {form.kind === "abbreviation" && (
                        <Field
                          label="Расшифровка"
                          htmlFor="brand-dictionary-expansion"
                          error={fieldError?.field === "expansion" ? fieldError.message : undefined}
                          messageId={expansionMessageId}
                          hint="Необязательно. Помогает проверить смысл аббревиатуры."
                        >
                          <Input
                            id="brand-dictionary-expansion"
                            value={form.expansion}
                            disabled={busy != null}
                            maxLength={500}
                            aria-invalid={fieldError?.field === "expansion" || undefined}
                            aria-describedby={expansionMessageId}
                            onChange={(event) => {
                              const expansion = event.currentTarget.value;
                              setForm((currentForm) => ({ ...currentForm, expansion }));
                              setFieldError(null);
                            }}
                          />
                        </Field>
                      )}
                    </div>
                  )}

                  <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[14px] text-text">
                    <input
                      type="checkbox"
                      checked={form.caseSensitive}
                      disabled={busy != null}
                      onChange={(event) => {
                        const caseSensitive = event.currentTarget.checked;
                        setForm((currentForm) => ({ ...currentForm, caseSensitive }));
                      }}
                      className="h-5 w-5 rounded border-line-strong accent-brand focus-visible:ring-4 focus-visible:ring-brand/15"
                    />
                    Учитывать регистр букв
                  </label>

                  <div className="flex justify-end">
                    <Button type="submit" variant="solid" loading={busy === "save"} disabled={busy === "delete"} className="w-full sm:w-auto">
                      {editing ? <Pencil className="h-4 w-4" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
                      {editing ? "Сохранить правило" : "Добавить правило"}
                    </Button>
                  </div>
                </form>
              ) : (
                <p className="rounded-sm bg-surface-inset p-4 text-[13px] leading-relaxed text-text-2">
                  Просмотр доступен всем участникам проекта. Добавлять и изменять правила может владелец.
                </p>
              )}

              <div>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-[15px] font-bold text-text">Правила проекта</h3>
                  <span className="text-[12px] font-medium text-text-3 tabular-nums">
                    {dictionary.entries.length} {plural(dictionary.entries.length, "правило", "правила", "правил")}
                  </span>
                </div>
                {dictionary.entries.length === 0 ? (
                  <div className="rounded-sm bg-surface-inset p-5 text-center">
                    <p className="text-[14px] font-semibold text-text">Словарь пока пуст</p>
                    <p className="mx-auto mt-1 max-w-[58ch] text-[13px] leading-relaxed text-text-2">
                      Добавь первое правило, чтобы Композитор проверял названия и исключения в контексте этого проекта.
                    </p>
                  </div>
                ) : (
                  <ul className="divide-y divide-line border-y border-line" aria-label="Правила словаря бренда">
                    {dictionary.entries.map((entry) => {
                      const copy = KIND_COPY[entry.kind];
                      return (
                        <li key={entry.id} className="flex flex-col gap-3 py-4 lg:flex-row lg:items-center lg:justify-between">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge tone={copy.tone}>{copy.label}</Badge>
                              {entry.caseSensitive && <Badge tone="neutral">С учётом регистра</Badge>}
                            </div>
                            <p className="mt-2 break-words text-[14px] leading-relaxed text-text">
                              <span className="font-semibold">{entry.term}</span>
                              {entry.replacement && (
                                <>
                                  <span className="mx-2 text-text-3" aria-hidden>→</span>
                                  <span className="font-semibold">{entry.replacement}</span>
                                </>
                              )}
                            </p>
                            {entry.expansion && (
                              <p className="mt-1 break-words text-[13px] leading-relaxed text-text-3">
                                Расшифровка: {entry.expansion}
                              </p>
                            )}
                          </div>
                          {canManage && (
                            <div className="flex shrink-0 gap-2">
                              <Button type="button" variant="ghost" size="sm" onClick={() => startEdit(entry)} disabled={busy != null}>
                                <Pencil className="h-4 w-4" aria-hidden />
                                Изменить
                              </Button>
                              <Button type="button" variant="danger" size="sm" onClick={() => setDeleting(entry)} disabled={busy != null}>
                                <Trash2 className="h-4 w-4" aria-hidden />
                                Удалить
                              </Button>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      </Card>

      <ConfirmDialog
        open={deleting != null}
        title="Удалить правило словаря?"
        description={deleting
          ? `Правило «${deleting.term}» перестанет действовать в новых проверках и публикациях. История версий сохранится.`
          : "Правило перестанет действовать в новых проверках."}
        confirmLabel="Удалить правило"
        busy={busy === "delete"}
        onCancel={() => {
          if (busy == null) setDeleting(null);
        }}
        onConfirm={() => void remove()}
      />
    </section>
  );
}
