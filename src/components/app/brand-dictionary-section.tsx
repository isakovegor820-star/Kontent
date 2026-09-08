"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  BookOpenCheck,
  ArrowRight,
  Check,
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
  termLabel: string;
  termExample: string;
  replacementExample: string;
  tone: "brand" | "success" | "danger" | "neutral" | "fire";
}> = {
  canonical: {
    label: "Писать правильно",
    description: "Единое написание названий компании и продуктов.",
    termLabel: "Как могут написать",
    termExample: "аврора",
    replacementExample: "Аврора",
    tone: "brand",
  },
  allowed: {
    label: "Разрешить вариант",
    description: "Оставить слово без замены по словарю. Обычная проверка текста сохраняется.",
    termLabel: "Какой вариант разрешить",
    termExample: "Аврора AI",
    replacementExample: "",
    tone: "success",
  },
  prohibited: {
    label: "Не использовать",
    description: "Отметить нежелательную фразу и предложить замену для проверки.",
    termLabel: "Какую фразу не использовать",
    termExample: "лучший на рынке",
    replacementExample: "помогает экономить время",
    tone: "danger",
  },
  exception: {
    label: "Сохранить как есть",
    description: "Защитить фразу, например слоган, от автоматических правок.",
    termLabel: "Какую фразу сохранить без изменений",
    termExample: "Идеи — в дело!",
    replacementExample: "",
    tone: "neutral",
  },
  abbreviation: {
    label: "Использовать сокращение",
    description: "Задать короткое название вместо полного.",
    termLabel: "Полное название",
    termExample: "искусственный интеллект",
    replacementExample: "ИИ",
    tone: "fire",
  },
};

const KIND_ORDER: BrandDictionaryEntryKind[] = ["canonical", "prohibited", "exception", "allowed", "abbreviation"];

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
  const addRef = useRef<HTMLButtonElement>(null);
  const requestSequence = useRef(0);

  const [dictionary, setDictionary] = useState<ClientBrandDictionary | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editing, setEditing] = useState<ClientBrandDictionaryEntry | null>(null);
  const [formOpen, setFormOpen] = useState(false);
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
      setFormOpen(false);
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
    setFormOpen(false);
    setForm(EMPTY_FORM);
    setFieldError(null);
    requestAnimationFrame(() => addRef.current?.focus());
  };

  const startCreate = (kind: BrandDictionaryEntryKind = "canonical") => {
    setEditing(null);
    setForm({ ...EMPTY_FORM, kind });
    setFormOpen(true);
    setFeedback(null);
    setFieldError(null);
    requestAnimationFrame(() => termRef.current?.focus());
  };

  const startEdit = (entry: ClientBrandDictionaryEntry) => {
    setEditing(entry);
    setFormOpen(true);
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
      expansion: form.kind === "abbreviation" ? form.expansion.trim() || null : null,
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
      text: savedEditing ? "Правило обновлено. Оно будет учтено при следующей проверке текста." : "Правило сохранено. Оно будет учтено при генерации и проверке текста.",
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
    setFeedback({ kind: "success", text: "Правило удалено. Оно больше не применяется при проверке текста." });
    await load();
    setBusy(null);
  };

  const requiresReplacement = form.kind !== "allowed" && form.kind !== "exception";
  const copy = KIND_COPY[form.kind];
  const originalForm = editing ? formForEntry(editing) : EMPTY_FORM;
  const dirty = formOpen && JSON.stringify(form) !== JSON.stringify(originalForm);

  return (
    <section aria-labelledby={sectionTitleId} data-settings-dirty={dirty || undefined}>
      <Card className="overflow-hidden">
        <div className="border-b border-line p-5 sm:p-7">
          <div className="flex items-center gap-3">
            <span aria-hidden className="grid h-10 w-10 shrink-0 place-items-center rounded-sm bg-info-soft text-info-text">
              <BookOpenCheck className="h-5 w-5" />
            </span>
            <div>
              <p className="text-[12px] font-medium text-text-3">Для всех каналов проекта</p>
              <h2 id={sectionTitleId} className="text-xl font-extrabold tracking-tight text-text">Правила написания</h2>
            </div>
          </div>
          <p className="mt-4 max-w-[65ch] text-[14px] leading-relaxed text-text-2">
            Задай, как писать названия и какие фразы не использовать. Аврора учтёт эти правила при генерации и проверке постов.
          </p>
          {!formOpen && <>
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-sm bg-surface-2 px-4 py-3 text-[14px]">
            <span className="text-text-3">Например:</span>
            <span className="text-text-2">аврора</span>
            <ArrowRight className="h-4 w-4 text-text-3" aria-label="заменить на" />
            <span className="font-bold text-text">Аврора</span>
            <span className="text-[13px] text-text-3">— название всегда в одном стиле</span>
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-text-3">Настраивать необязательно. Добавь правило, если Аврора ошибается в названии или использует неподходящие слова.</p>
          </>}
        </div>

        <div className="space-y-5 p-5 sm:p-7">
          <div aria-live="polite" aria-atomic="true" className="empty:hidden">
            {feedback && <p role={feedback.kind === "error" ? "alert" : "status"} className={feedback.kind === "error" ? "text-[14px] text-danger-text" : "text-[14px] text-success-text"}>{feedback.text}</p>}
          </div>

          {!current ? (
            <p className="text-[14px] text-text-2">Выбери проект, чтобы настроить правила написания.</p>
          ) : loading && !dictionary ? (
            <div role="status" aria-busy="true" className="space-y-3">
              <span className="sr-only">Загружаем правила написания</span>
              <div className="skeleton h-12 rounded-sm" aria-hidden />
              <div className="skeleton h-20 rounded-sm" aria-hidden />
            </div>
          ) : loadError || !dictionary ? (
            <div role="alert" className="rounded-sm border border-danger/30 bg-danger-soft p-4">
              <p className="flex items-center gap-2 text-[14px] font-semibold text-danger-text"><TriangleAlert className="h-5 w-5" aria-hidden />Не удалось загрузить правила</p>
              <p className="mt-2 text-[13px] text-text-2">Попробуй ещё раз, чтобы увидеть сохранённые правила.</p>
              <Button type="button" variant="secondary" size="sm" onClick={() => void load()} className="mt-3"><RefreshCw className="h-4 w-4" aria-hidden />Загрузить снова</Button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-[16px] font-bold text-text">Твои правила <span className="ml-1 text-[13px] font-normal text-text-3">{dictionary.entries.length}</span></h3>
                {canManage && !formOpen && <Button ref={addRef} type="button" variant="primary" size="sm" onClick={() => startCreate()} disabled={busy != null}><Plus className="h-4 w-4" aria-hidden />Добавить правило</Button>}
              </div>

              {canManage && formOpen && (
                <form onSubmit={save} className="space-y-5 rounded-sm border border-brand/25 bg-surface-2 p-4 sm:p-5" aria-label={editing ? "Изменение правила" : "Новое правило"}>
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-[16px] font-bold text-text">{editing ? "Изменить правило" : "Новое правило"}</h3>
                    <Button type="button" variant="ghost" size="sm" onClick={resetForm} disabled={busy != null}><X className="h-4 w-4" aria-hidden />Отмена</Button>
                  </div>
                  <fieldset disabled={busy != null}>
                    <legend className="mb-2 text-[13px] font-semibold text-text-2">Что должна сделать Аврора?</legend>
                    <div className="flex flex-wrap gap-2">
                      {KIND_ORDER.map((kind) => (
                        <label key={kind} className="relative cursor-pointer">
                          <input type="radio" name="brand-rule-kind" value={kind} checked={form.kind === kind} className="peer sr-only" onChange={() => {
                            setForm((value) => ({ ...value, kind, replacement: kind === "allowed" || kind === "exception" ? "" : value.replacement, expansion: kind === "abbreviation" ? value.expansion : "" }));
                            setFieldError(null);
                          }} />
                          <span className="flex min-h-11 items-center rounded-xs border border-line bg-surface px-3 py-2 text-[13px] font-medium text-text-2 peer-checked:border-brand peer-checked:bg-info-soft peer-checked:text-info-text peer-focus-visible:ring-4 peer-focus-visible:ring-brand/20 peer-disabled:opacity-50">{KIND_COPY[kind].label}</span>
                        </label>
                      ))}
                    </div>
                    <p className="mt-2 text-[13px] leading-relaxed text-text-3">{copy.description}</p>
                  </fieldset>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={copy.termLabel} htmlFor="brand-dictionary-term" required error={fieldError?.field === "term" ? fieldError.message : undefined} messageId={termMessageId} hint={`Например: ${copy.termExample}`}>
                      <Input ref={termRef} id="brand-dictionary-term" required value={form.term} disabled={busy != null} maxLength={240} placeholder={copy.termExample} aria-invalid={fieldError?.field === "term" || undefined} aria-describedby={termMessageId} onChange={(event) => { const term = event.currentTarget.value; setForm((value) => ({ ...value, term })); setFieldError(null); }} />
                    </Field>
                    {requiresReplacement && <Field label={form.kind === "abbreviation" ? "Как сокращать" : "Как нужно написать"} htmlFor="brand-dictionary-replacement" required error={fieldError?.field === "replacement" ? fieldError.message : undefined} messageId={replacementMessageId} hint={`Например: ${copy.replacementExample}`}>
                      <Input id="brand-dictionary-replacement" required value={form.replacement} disabled={busy != null} maxLength={240} placeholder={copy.replacementExample} aria-invalid={fieldError?.field === "replacement" || undefined} aria-describedby={replacementMessageId} onChange={(event) => { const replacement = event.currentTarget.value; setForm((value) => ({ ...value, replacement })); setFieldError(null); }} />
                    </Field>}
                  </div>
                  {form.kind === "abbreviation" && <Field label="Расшифровка сокращения" htmlFor="brand-dictionary-expansion" error={fieldError?.field === "expansion" ? fieldError.message : undefined} messageId={expansionMessageId} hint="Необязательно. Помогает проверить смысл сокращения.">
                    <Input id="brand-dictionary-expansion" value={form.expansion} disabled={busy != null} maxLength={500} aria-invalid={fieldError?.field === "expansion" || undefined} aria-describedby={expansionMessageId} onChange={(event) => { const expansion = event.currentTarget.value; setForm((value) => ({ ...value, expansion })); setFieldError(null); }} />
                  </Field>}

                  <div className="rounded-sm border border-line bg-surface p-4" aria-live="polite" aria-atomic="true">
                    <p className="text-[12px] font-semibold text-text-3">{form.term.trim() && (!requiresReplacement || form.replacement.trim()) ? "Как сработает правило при проверке" : "Пример правила"}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2 break-words text-[16px] text-text [overflow-wrap:anywhere]">
                      <span>{form.term.trim() || copy.termExample}</span>
                      {requiresReplacement ? <><ArrowRight className="h-4 w-4 shrink-0 text-text-3" aria-label="заменить на" /><strong>{form.replacement.trim() || copy.replacementExample}</strong></> : <span className="inline-flex items-center gap-1 text-[13px] text-success-text"><Check className="h-4 w-4" aria-hidden />{form.kind === "exception" ? "Без автоматических правок" : "Без замены по словарю"}</span>}
                    </div>
                    <p className="mt-2 text-[13px] leading-relaxed text-text-2">{form.kind === "canonical" ? "Аврора предложит привести название к этому написанию." : form.kind === "prohibited" || form.kind === "abbreviation" ? "Аврора предложит замену, которую нужно проверить и подтвердить." : copy.description}</p>
                  </div>

                  <details className="text-[13px] text-text-2" open={form.caseSensitive || undefined}>
                    <summary className="min-h-11 cursor-pointer py-3 font-medium focus-visible:outline-brand">Дополнительные настройки{form.caseSensitive ? " · точное совпадение букв" : ""}</summary>
                    <label className="flex min-h-11 cursor-pointer items-start gap-3 py-2">
                      <input type="checkbox" checked={form.caseSensitive} disabled={busy != null} onChange={(event) => { const caseSensitive = event.currentTarget.checked; setForm((value) => ({ ...value, caseSensitive })); }} className="mt-0.5 h-5 w-5 shrink-0 accent-brand" />
                      <span>Различать большие и маленькие буквы<span className="mt-1 block text-[12px] leading-relaxed text-text-3">Если включить, «Аврора» и «аврора» будут считаться разными вариантами.</span></span>
                    </label>
                  </details>
                  <div className="flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-[12px] leading-relaxed text-text-3">Применится к следующим генерациям и проверкам.</p>
                    <Button type="submit" variant="primary" loading={busy === "save"} disabled={busy === "delete"} className="shrink-0"><Check className="h-4 w-4" aria-hidden />Сохранить правило</Button>
                  </div>
                </form>
              )}

              {!canManage && <p className="rounded-sm bg-surface-inset p-4 text-[13px] leading-relaxed text-text-2">Правила действуют для всего проекта. Добавлять и изменять их может владелец.</p>}

              {dictionary.entries.length === 0 ? (!formOpen && <div>
                <p className="text-[14px] font-semibold text-text">{canManage ? "Пока нет правил — с чего начнём?" : "В проекте пока нет правил"}</p>
                {canManage && <p className="mt-1 text-[13px] leading-relaxed text-text-3">Выбери задачу и добавь своё первое правило.</p>}
                {canManage && <div className="mt-4 grid gap-3 lg:grid-cols-3">
                  {(["canonical", "prohibited", "exception"] as const).map((kind) => <button key={kind} type="button" onClick={() => startCreate(kind)} disabled={busy != null} className="group rounded-sm border border-line bg-surface p-4 text-left transition-colors hover:border-brand/40 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
                    <span className="flex items-center justify-between gap-2 text-[14px] font-bold text-text">{KIND_COPY[kind].label}<Plus className="h-4 w-4 shrink-0 text-brand" aria-hidden /></span>
                    <span className="mt-2 block text-[13px] font-normal leading-relaxed text-text-3">{KIND_COPY[kind].description}</span>
                    <span className="mt-4 block text-[12px] font-medium text-info-text">{kind === "canonical" ? "аврора → Аврора" : kind === "prohibited" ? "Например: «лучший на рынке»" : "Например: слоган компании"}</span>
                  </button>)}
                </div>}
              </div>) : (
                <ul className="divide-y divide-line" aria-label="Сохранённые правила">
                  {dictionary.entries.map((entry) => <li key={entry.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2"><Badge tone={KIND_COPY[entry.kind].tone}>{KIND_COPY[entry.kind].label}</Badge>{entry.caseSensitive && <Badge tone="neutral">Точное совпадение букв</Badge>}</div>
                      <p className="mt-2 break-words text-[15px] leading-relaxed text-text"><strong>{entry.term}</strong>{entry.replacement && <><span className="mx-2 text-text-3" aria-label="заменить на">→</span><strong>{entry.replacement}</strong></>}</p>
                      <p className="mt-1 text-[12px] leading-relaxed text-text-3">{KIND_COPY[entry.kind].description}</p>
                      {entry.expansion && <p className="mt-1 break-words text-[13px] text-text-3">Расшифровка: {entry.expansion}</p>}
                    </div>
                    {canManage && <div className="flex shrink-0 gap-1">
                      <Button type="button" variant="ghost" size="sm" onClick={() => startEdit(entry)} disabled={busy != null || formOpen} aria-label={`Изменить правило: ${entry.term}`}><Pencil className="h-4 w-4" aria-hidden />Изменить</Button>
                      <Button type="button" variant="ghost" size="icon" onClick={() => setDeleting(entry)} disabled={busy != null || formOpen} aria-label={`Удалить правило: ${entry.term}`} className="text-danger-text"><Trash2 className="h-4 w-4" aria-hidden /></Button>
                    </div>}
                  </li>)}
                </ul>
              )}
            </>
          )}
        </div>
      </Card>
      <ConfirmDialog open={deleting != null} title="Удалить правило?" description={deleting ? `Правило «${deleting.term}» перестанет применяться при генерации и проверке новых текстов.` : "Правило перестанет применяться."} confirmLabel="Удалить правило" busy={busy === "delete"} onCancel={() => { if (busy == null) setDeleting(null); }} onConfirm={() => void remove()} />
    </section>
  );
}
