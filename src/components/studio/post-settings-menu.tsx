"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, ChevronDown, Info, Plus, RotateCcw, Search, SlidersHorizontal, Sparkles, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  POST_SETTINGS_FIELDS,
  POST_SETTINGS_GROUPS,
  fieldsForGroup,
  isTechnicalField,
  searchFields,
  type PostSettingsField,
  type PostSettingsGroupId,
} from "@/lib/post-settings-fields";
import {
  POST_PRESETS,
  POST_TARGET_OPTIONS,
  POST_TARGET_RULES,
  applyPostPreset,
  automaticPostSettings,
  buildPostSettingsSummary,
  normalizePostSettings,
  patchPostSettings,
  postLengthRange,
  postSettingsAreAutomatic,
  resolvePostTarget,
  validatePostSettingsConflicts,
  type PostPresetId,
  type PostProof,
  type PostSettings,
} from "@/lib/post-settings";
import { cn } from "@/lib/utils";

type SettingsTab = "quick" | "advanced";

const selectClass =
  "h-11 w-full rounded-sm border border-line bg-surface px-3 text-base font-medium text-text outline-none transition-colors hover:border-line-strong focus:border-brand focus:ring-2 focus:ring-brand/15 sm:text-[13px]";
const inputClass =
  "min-h-11 w-full rounded-sm border border-line bg-surface px-3 py-2 text-base leading-relaxed text-text outline-none placeholder:text-text-3 transition-colors hover:border-line-strong focus:border-brand focus:ring-2 focus:ring-brand/15 sm:text-[13px]";

/* ------------------------------------------------------------------ утилиты */

/** Значение поля «как в авто» — с ним сравниваем, чтобы показать «изменено». */
function autoValue(key: keyof PostSettings): unknown {
  return automaticPostSettings()[key];
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) return JSON.stringify(left) === JSON.stringify(right);
  return left === right;
}

export function fieldIsOverridden(settings: PostSettings, key: keyof PostSettings): boolean {
  return !sameValue(settings[key], autoValue(key));
}

/** Сколько правил пользователь включил вручную — это и есть «активные настройки». */
export function overriddenFieldKeys(settings: PostSettings): (keyof PostSettings)[] {
  return POST_SETTINGS_FIELDS.filter((field) => !isTechnicalField(field))
    .filter((field) => fieldIsOverridden(settings, field.key))
    .map((field) => field.key);
}

function groupOverrideCount(settings: PostSettings, group: PostSettingsGroupId): number {
  const keys = new Set(fieldsForGroup(group, settings).map((field) => field.key as string));
  return overriddenFieldKeys(settings).filter((key) => keys.has(key as string)).length;
}

/* -------------------------------------------------------------- примитивы */

function OverrideBadge({ onReset }: { onReset: () => void }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <span className="rounded-full bg-brand/10 px-1.5 py-0.5 text-[10px] font-bold text-brand">изменено</span>
      <button
        type="button"
        onClick={onReset}
        title="Вернуть автоматическое значение"
        aria-label="Вернуть автоматическое значение"
        className="grid h-6 w-6 place-items-center rounded-full text-text-3 transition-colors hover:bg-surface-inset hover:text-text"
      >
        <RotateCcw className="h-3.5 w-3.5" aria-hidden />
      </button>
    </span>
  );
}

function FieldShell({
  field,
  overridden,
  onReset,
  span,
  children,
}: {
  field: PostSettingsField;
  overridden: boolean;
  onReset: () => void;
  span?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("min-w-0", span && "sm:col-span-2")} data-setting={field.key}>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 text-[12px] font-bold text-text">{field.label}</span>
        {overridden ? <OverrideBadge onReset={onReset} /> : null}
      </div>
      {field.help ? (
        <p className="mt-0.5 flex items-start gap-1 text-[10px] leading-snug text-text-3">
          <Info className="mt-[1px] h-3 w-3 shrink-0" aria-hidden />
          <span>{field.help}</span>
        </p>
      ) : null}
      <div className="mt-1.5">{children}</div>
      {field.dependsOn ? <p className="mt-1 text-[10px] leading-snug text-text-3">Работает при условии: {field.dependsOn}.</p> : null}
    </div>
  );
}

function SelectControl({
  id,
  value,
  options,
  onChange,
}: {
  id: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative">
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)} className={cn(selectClass, "appearance-none pr-9")}>
        {options.map(([optionId, label]) => (
          <option key={optionId} value={optionId}>
            {label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3" aria-hidden />
    </div>
  );
}

function TextControl({
  id,
  value,
  placeholder,
  multiline,
  type = "text",
  min,
  max,
  datalist,
  onChange,
}: {
  id: string;
  value: string;
  placeholder?: string;
  multiline?: boolean;
  type?: "text" | "number";
  min?: number;
  max?: number;
  datalist?: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
}) {
  if (multiline) {
    return (
      <textarea
        id={id}
        rows={2}
        className={cn(inputClass, "resize-y")}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  return (
    <>
      <input
        id={id}
        className={inputClass}
        type={type}
        inputMode={type === "number" ? "numeric" : "text"}
        min={min}
        max={max}
        list={datalist ? `${id}-list` : undefined}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {datalist ? (
        <datalist id={`${id}-list`}>
          {datalist
            .filter(([optionValue]) => optionValue)
            .map(([optionValue, label]) => (
              <option key={optionValue} value={optionValue}>
                {label}
              </option>
            ))}
        </datalist>
      ) : null}
    </>
  );
}

function ToggleControl({
  id,
  checked,
  label,
  onChange,
}: {
  id: string;
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex h-11 w-full items-center justify-between gap-3 rounded-sm border px-3 text-[12px] font-semibold transition-colors",
        checked ? "border-brand/40 bg-brand/5 text-text" : "border-line bg-surface text-text-2 hover:border-line-strong",
      )}
    >
      <span>{checked ? "Включено" : "Выключено"}</span>
      <span className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", checked ? "bg-brand" : "bg-line-strong")}>
        <span
          className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all", checked ? "left-[18px]" : "left-0.5")}
        />
      </span>
    </button>
  );
}

function MultiSelectControl({
  id,
  values,
  options,
  onChange,
}: {
  id: string;
  values: string[];
  options: readonly (readonly [string, string])[];
  onChange: (values: string[]) => void;
}) {
  return (
    <div id={id} className="flex flex-wrap gap-1.5">
      {options.map(([optionId, label]) => {
        const active = values.includes(optionId);
        return (
          <button
            key={optionId}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(active ? values.filter((item) => item !== optionId) : [...values, optionId])}
            className={cn(
              "inline-flex min-h-9 items-center gap-1 rounded-full border px-3 text-[12px] font-semibold transition-colors",
              active
                ? "border-brand bg-brand/10 text-brand"
                : "border-line bg-surface text-text-2 hover:border-line-strong hover:text-text",
            )}
          >
            {active ? <Check className="h-3.5 w-3.5" aria-hidden /> : null}
            {label}
          </button>
        );
      })}
    </div>
  );
}

function ListControl({
  id,
  values,
  placeholder,
  onChange,
}: {
  id: string;
  values: string[];
  placeholder?: string;
  onChange: (values: string[]) => void;
}) {
  return (
    <textarea
      id={id}
      rows={3}
      className={cn(inputClass, "resize-y font-normal")}
      value={values.join("\n")}
      placeholder={placeholder}
      onChange={(event) =>
        onChange(
          event.target.value
            .split("\n")
            .map((item) => item.trim())
            .filter(Boolean),
        )
      }
    />
  );
}

const proofTypes = [
  ["number", "Цифра"],
  ["statistic", "Статистика"],
  ["case", "Кейс"],
  ["review", "Отзыв"],
  ["quote", "Цитата"],
  ["experience", "Личный опыт"],
  ["research", "Исследование"],
  ["certificate", "Сертификат"],
  ["demo", "Демонстрация"],
  ["comparison", "Сравнение"],
  ["product_fact", "Факт о продукте"],
] as const;

/* ------------------------------------------------------- блок «автоподбор» */

function AutomaticSettingsAction({
  pending,
  saved,
  saving,
  advanced = false,
  onSelect,
}: {
  pending: boolean;
  saved: boolean;
  saving?: boolean;
  advanced?: boolean;
  onSelect: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-brand/25 bg-brand/5 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-[12px] font-extrabold text-text">
          {advanced ? "Автоподбор всех расширенных настроек" : "Тему напиши сообщением в чате"}
        </p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-text-2">
          {advanced
            ? "Аврора очистит ручные ограничения и заново подберёт каждый параметр по задаче, площадке и голосу канала."
            : "Аврора возьмёт задачу из сообщения — дублировать её в настройках не нужно."}
        </p>
      </div>
      <div className="shrink-0 sm:text-right">
        <Button
          type="button"
          variant={pending || saved ? "soft" : "outline"}
          size="sm"
          className="min-h-11"
          disabled={saving}
          onClick={onSelect}
        >
          {pending ? <Check className="h-4 w-4" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
          {pending ? "Автоподбор готов" : saved ? "Подобрать заново" : "Выбрать автоматически"}
        </Button>
        <p role="status" aria-live="polite" className="mt-1.5 max-w-[34ch] text-[10px] leading-relaxed text-text-3">
          {saving && pending
            ? "Сохраняем автоматический выбор…"
            : pending
              ? "Нажми «Сохранить настройки», чтобы применить новый автоподбор."
              : saved
                ? "Автоматический режим сохранён. Его можно запустить и сохранить повторно."
                : "Автоподбор подготовит новый профиль; сохранение останется отдельным действием."}
        </p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- компонент */

export function PostSettingsMenu({
  value,
  onChange,
  network,
  disabled,
  saving,
  initialOpen,
}: {
  value: PostSettings;
  onChange: (value: PostSettings) => void;
  network?: string | null;
  disabled?: boolean;
  saving?: boolean;
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(initialOpen));
  const [tab, setTab] = useState<SettingsTab>("quick");
  const [activeGroup, setActiveGroup] = useState<PostSettingsGroupId>("base");
  const [query, setQuery] = useState("");
  const [automaticSelectionPending, setAutomaticSelectionPending] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const proofSeq = useRef(0);
  const persisted = normalizePostSettings(value);
  const [draft, setDraft] = useState<PostSettings>(() => persisted);
  const settings = normalizePostSettings(draft);
  const dirty = JSON.stringify(settings) !== JSON.stringify(persisted);
  const automatic = postSettingsAreAutomatic(settings);
  const automaticSaved = automatic && !dirty && !automaticSelectionPending;
  const hasPendingChanges = dirty || automaticSelectionPending;
  const target = resolvePostTarget(settings, network);
  const rule = POST_TARGET_RULES[target];
  const [minChars, maxChars] = postLengthRange(settings, network);
  const preset = POST_PRESETS.find((item) => item.id === settings.preset);
  const conflicts = validatePostSettingsConflicts(settings);
  const blockers = conflicts.filter((item) => item.severity === "error");
  const summary = buildPostSettingsSummary(settings, network);

  // Считаем прямо в рендере: normalizePostSettings каждый раз возвращает новый объект,
  // поэтому ручная мемоизация здесь всё равно не сохраняется (React Compiler её отвергает).
  const overridden = overriddenFieldKeys(settings);
  const overriddenSet = new Set(overridden.map(String));
  const visibleCount = POST_SETTINGS_FIELDS.filter((field) => !isTechnicalField(field)).length;
  const results = searchFields(query, settings);
  const group = POST_SETTINGS_GROUPS.find((item) => item.id === activeGroup) ?? POST_SETTINGS_GROUPS[0];

  useEffect(() => {
    if (!open) return;
    const focusFrame = window.requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector<HTMLElement>("button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled])")
        ?.focus();
    });
    const onPointer = (event: MouseEvent) => {
      const clickTarget = event.target as Node;
      if (rootRef.current && !rootRef.current.contains(clickTarget) && !panelRef.current?.contains(clickTarget)) {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (event.key === "Tab" && panelRef.current) {
        const focusable = Array.from(
          panelRef.current.querySelectorAll<HTMLElement>(
            "button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href]",
          ),
        ).filter((element) => element.getClientRects().length > 0);
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const update = (patch: Partial<PostSettings>, keepPreset = false) => {
    setAutomaticSelectionPending(false);
    setDraft(
      keepPreset
        ? normalizePostSettings({
            ...settings,
            ...patch,
            preset: settings.preset,
          })
        : patchPostSettings(settings, patch),
    );
  };

  const addProof = () => {
    proofSeq.current += 1;
    const proof: PostProof = {
      id: `proof-new-${proofSeq.current}`,
      type: "product_fact",
      text: "",
      source: "",
      validAt: "",
      required: false,
      allowClientName: false,
      allowParaphrase: true,
    };
    update({ proofs: [...settings.proofs, proof] });
  };
  const updateProof = (id: string, patch: Partial<PostProof>) =>
    update({
      proofs: settings.proofs.map((proof) => (proof.id === id ? { ...proof, ...patch } : proof)),
    });
  const removeProof = (id: string) => update({ proofs: settings.proofs.filter((proof) => proof.id !== id) });

  const targetOptions: readonly (readonly [string, string])[] = [
    ["auto", `Авто · ${rule.shortLabel}`],
    ...POST_TARGET_OPTIONS.map((item): [string, string] => [item.id, item.label]),
  ];
  const presetOptions: readonly (readonly [string, string])[] = [
    ["auto", "Авто — подобрать по задаче"],
    ...POST_PRESETS.map((item): [string, string] => [item.id, item.label]),
    ["custom", "Настроено вручную"],
  ];

  const useAutomaticQuickSettings = () => {
    const next = automaticPostSettings();
    setDraft(next);
    // Even when Auto is already persisted, this is a fresh user action. Keep an explicit
    // pending marker so the Save button remains available and the profile is written again.
    setAutomaticSelectionPending(true);
  };

  const resetAllToAuto = () => {
    setDraft(automaticPostSettings());
    setAutomaticSelectionPending(true);
  };

  const renderField = (field: PostSettingsField) => {
    const id = `post-setting-${field.key}`;
    const isOverridden = overriddenSet.has(String(field.key));
    const reset = () => update({ [field.key]: autoValue(field.key) } as Partial<PostSettings>);
    const spanTwo = field.kind === "proofs" || (field.kind === "list" && Boolean(field.options)) || field.kind === "textarea";

    if (field.kind === "proofs") {
      return (
        <FieldShell key={field.key} field={field} overridden={isOverridden} onReset={reset} span>
          <div className="grid gap-3">
            {settings.proofs.map((proof, index) => (
              <div key={proof.id} className="rounded-sm border border-line bg-surface-2 p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[11px] font-extrabold text-text">Доказательство {index + 1}</p>
                  <button
                    type="button"
                    onClick={() => removeProof(proof.id)}
                    className="grid h-9 w-9 place-items-center rounded-full text-text-3 hover:bg-danger-soft hover:text-danger-text"
                    aria-label={`Удалить доказательство ${index + 1}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <label className="block">
                    <span className="text-[11px] font-bold text-text-2">Тип</span>
                    <div className="mt-1">
                      <SelectControl
                        id={`proof-${proof.id}-type`}
                        value={proof.type}
                        options={proofTypes}
                        onChange={(next) =>
                          updateProof(proof.id, {
                            type: next as PostProof["type"],
                          })
                        }
                      />
                    </div>
                  </label>
                  <label className="block">
                    <span className="text-[11px] font-bold text-text-2">Дата актуальности</span>
                    <div className="mt-1">
                      <TextControl
                        id={`proof-${proof.id}-date`}
                        value={proof.validAt}
                        onChange={(next) => updateProof(proof.id, { validAt: next })}
                      />
                    </div>
                  </label>
                  <label className="block sm:col-span-2">
                    <span className="text-[11px] font-bold text-text-2">Само доказательство</span>
                    <div className="mt-1">
                      <TextControl
                        id={`proof-${proof.id}-text`}
                        value={proof.text}
                        onChange={(next) => updateProof(proof.id, { text: next })}
                      />
                    </div>
                  </label>
                  <label className="block sm:col-span-2">
                    <span className="text-[11px] font-bold text-text-2">Источник</span>
                    <div className="mt-1">
                      <TextControl
                        id={`proof-${proof.id}-source`}
                        value={proof.source}
                        onChange={(next) => updateProof(proof.id, { source: next })}
                      />
                    </div>
                  </label>
                  <ToggleControl
                    id={`proof-${proof.id}-required`}
                    label="Использовать обязательно"
                    checked={proof.required}
                    onChange={(next) => updateProof(proof.id, { required: next })}
                  />
                  <ToggleControl
                    id={`proof-${proof.id}-name`}
                    label="Можно указать имя"
                    checked={proof.allowClientName}
                    onChange={(next) => updateProof(proof.id, { allowClientName: next })}
                  />
                  <ToggleControl
                    id={`proof-${proof.id}-paraphrase`}
                    label="Можно перефразировать"
                    checked={proof.allowParaphrase}
                    onChange={(next) => updateProof(proof.id, { allowParaphrase: next })}
                  />
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={addProof}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-sm border border-dashed border-line-strong px-3 text-[12px] font-bold text-text-2 hover:bg-surface-inset"
            >
              <Plus className="h-4 w-4" aria-hidden /> Добавить доказательство
            </button>
          </div>
        </FieldShell>
      );
    }

    if (field.kind === "toggle") {
      return (
        <FieldShell key={field.key} field={field} overridden={isOverridden} onReset={reset} span>
          <ToggleControl
            id={id}
            label={field.label}
            checked={Boolean(settings[field.key])}
            onChange={(next) => update({ [field.key]: next } as Partial<PostSettings>)}
          />
        </FieldShell>
      );
    }

    if (field.kind === "list" && field.options) {
      const values = (settings[field.key] as string[]) ?? [];
      return (
        <FieldShell key={field.key} field={field} overridden={isOverridden} onReset={reset} span>
          <MultiSelectControl
            id={id}
            values={values}
            options={field.options}
            onChange={(next) => update({ [field.key]: next } as Partial<PostSettings>)}
          />
        </FieldShell>
      );
    }

    if (field.kind === "list") {
      return (
        <FieldShell key={field.key} field={field} overridden={isOverridden} onReset={reset} span={spanTwo}>
          <ListControl
            id={id}
            values={(settings[field.key] as string[]) ?? []}
            placeholder={field.placeholder}
            onChange={(next) => update({ [field.key]: next } as Partial<PostSettings>)}
          />
        </FieldShell>
      );
    }

    if (field.kind === "select") {
      const options = field.key === "target" ? targetOptions : field.key === "preset" ? presetOptions : (field.options ?? []);
      const raw = String(settings[field.key] ?? "");
      return (
        <FieldShell key={field.key} field={field} overridden={isOverridden} onReset={reset} span={spanTwo}>
          <SelectControl
            id={id}
            value={raw}
            options={options}
            onChange={(next) => {
              if (field.key === "target") update({ target: next as PostSettings["target"] }, true);
              else if (field.key === "preset") {
                setAutomaticSelectionPending(false);
                if (next === "auto") setDraft(normalizePostSettings({ ...settings, preset: "auto" }));
                else if (next !== "custom") setDraft(applyPostPreset(settings, next as Exclude<PostPresetId, "auto" | "custom">));
              } else update({ [field.key]: next } as Partial<PostSettings>);
            }}
          />
          {field.key === "preset" && preset ? <p className="mt-1.5 text-[11px] leading-relaxed text-text-3">{preset.description}</p> : null}
          {field.key === "length" && settings.length === "custom" ? (
            <p className="mt-1.5 text-[11px] leading-relaxed text-text-3">
              Сейчас: {settings.customMinChars ?? 300}–{settings.customMaxChars ?? 1200} знаков.
            </p>
          ) : null}
        </FieldShell>
      );
    }

    if (field.kind === "number") {
      const raw = field.key === "ctaRepeats" ? String(settings.ctaRepeats) : String(settings[field.key] ?? "");
      return (
        <FieldShell key={field.key} field={field} overridden={isOverridden} onReset={reset}>
          <TextControl
            id={id}
            type="number"
            min={field.min}
            max={
              field.key === "hashtagCount"
                ? rule.platformHashtagMax
                : field.key === "customMaxChars" || field.key === "customMinChars"
                  ? rule.hardLimit
                  : field.max
            }
            value={raw}
            onChange={(next) => update({ [field.key]: Number(next) } as Partial<PostSettings>)}
          />
        </FieldShell>
      );
    }

    return (
      <FieldShell key={field.key} field={field} overridden={isOverridden} onReset={reset} span={spanTwo}>
        <TextControl
          id={id}
          value={String(settings[field.key] ?? "")}
          placeholder={field.placeholder}
          multiline={field.kind === "textarea"}
          datalist={field.options}
          onChange={(next) => update({ [field.key]: next } as Partial<PostSettings>)}
        />
      </FieldShell>
    );
  };

  const footerSummary = (
    <div className="min-w-0">
      <p className="text-[11px] leading-relaxed text-text-3">
        {hasPendingChanges ? "Изменения пока не применены к следующим публикациям." : "Все настройки публикации сохранены."}
      </p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-2">
        {overridden.length === 0
          ? "Сейчас работает только автоподбор — ни одно правило не задано вручную."
          : `Вручную задано правил: ${overridden.length}. Аврора проверит пост по каждому.`}
      </p>
    </div>
  );

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => {
          if (open) setOpen(false);
          else {
            setDraft(normalizePostSettings(value));
            setAutomaticSelectionPending(false);
            setQuery("");
            setOpen(true);
          }
        }}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="dialog"
        aria-label="Настройки публикации"
        className={cn(
          "inline-flex min-h-11 max-w-[220px] min-w-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5",
          "text-[12px] font-semibold text-text-2 transition-colors hover:bg-surface-2 hover:text-text",
          "disabled:pointer-events-none disabled:opacity-45",
          open && "bg-surface-2 text-text",
        )}
      >
        <SlidersHorizontal className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
        <span className="truncate">Настройки</span>
        {overridden.length > 0 ? (
          <span className="shrink-0 rounded-full bg-brand/12 px-1.5 text-[10px] font-bold text-brand" aria-hidden>
            {overridden.length}
          </span>
        ) : null}
        {saving ? <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-brand" aria-label="Сохраняю" /> : null}
      </button>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-modal="true"
            aria-label="Настройки публикации"
            className={cn(
              "fixed z-50 flex flex-col overflow-hidden border border-line-strong bg-surface-2 shadow-lift",
              "inset-x-0 top-0 bottom-0 rounded-none",
              "sm:inset-x-auto sm:right-4 sm:top-1/2 sm:bottom-auto sm:h-[min(860px,calc(100dvh-2rem))] sm:w-[min(920px,calc(100vw-2rem))] sm:-translate-y-1/2 sm:rounded-lg",
            )}
          >
            {/* ШАПКА: что настраиваем и в каком состоянии */}
            <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3.5 sm:px-5">
              <div className="min-w-0">
                <p className="text-[15px] font-extrabold text-text">Как написать публикацию</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <span className="rounded-full bg-surface-inset px-2 py-0.5 text-[11px] font-semibold text-text-2">{rule.label}</span>
                  <span className="rounded-full bg-surface-inset px-2 py-0.5 text-[11px] font-semibold text-text-2">
                    {minChars}–{maxChars} знаков
                  </span>
                  <span className="rounded-full bg-surface-inset px-2 py-0.5 text-[11px] font-semibold text-text-2">
                    {settings.qualityMode === "maximum" ? "Максимум" : settings.qualityMode === "balanced" ? "Качественно" : "Быстро"}
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span role="status" aria-live="polite" className="inline-flex items-center gap-1 text-[10px] font-semibold text-text-3">
                  {!saving && !hasPendingChanges && <Check className="h-3.5 w-3.5 text-success-text" aria-hidden />}
                  {saving ? "Сохраняю…" : hasPendingChanges ? "Есть изменения" : "Сохранено"}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                  aria-label="Закрыть настройки публикации"
                  className="grid h-11 w-11 place-items-center rounded-sm text-text-3 hover:bg-surface-inset hover:text-text"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>
            </div>

            {/* ПАНЕЛЬ: режим и поиск */}
            <div className="flex flex-col gap-2 border-b border-line px-4 py-2.5 sm:flex-row sm:items-center sm:px-5">
              <div
                className="grid grid-cols-2 gap-1 rounded-sm bg-surface-inset p-1 sm:w-[320px]"
                role="group"
                aria-label="Режим настроек публикации"
              >
                {(["quick", "advanced"] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setTab(item)}
                    aria-pressed={tab === item}
                    className={cn(
                      "min-h-10 rounded-xs px-3 text-[12px] font-bold transition-colors",
                      tab === item ? "bg-surface text-text shadow-sm" : "text-text-3 hover:text-text",
                    )}
                  >
                    {item === "quick" ? "Простой режим" : "Все настройки"}
                  </button>
                ))}
              </div>
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3" aria-hidden />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Найти настройку — например «эмодзи» или «цена»"
                  aria-label="Поиск по настройкам публикации"
                  className="h-11 w-full rounded-sm border border-line bg-surface pl-9 pr-9 text-[13px] text-text outline-none placeholder:text-text-3 focus:border-brand focus:ring-2 focus:ring-brand/15"
                />
                {query ? (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    aria-label="Очистить поиск"
                    className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full text-text-3 hover:bg-surface-inset hover:text-text"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                ) : null}
              </div>
            </div>

            {/* ТЕЛО: навигация по группам и содержимое */}
            <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
              {tab === "advanced" && !query ? (
                <nav
                  aria-label="Разделы настроек"
                  className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-2 py-2 sm:w-[236px] sm:flex-col sm:overflow-y-auto sm:border-b-0 sm:border-r sm:px-2.5 sm:py-3"
                >
                  {POST_SETTINGS_GROUPS.map((item) => {
                    const count = groupOverrideCount(settings, item.id);
                    const active = item.id === activeGroup;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setActiveGroup(item.id)}
                        aria-current={active ? "true" : undefined}
                        className={cn(
                          "flex min-h-11 shrink-0 items-center justify-between gap-2 rounded-sm px-2.5 text-left transition-colors sm:w-full",
                          active ? "bg-brand/10 text-text" : "text-text-2 hover:bg-surface-inset hover:text-text",
                        )}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-[12px] font-bold">{item.title}</span>
                          <span className="hidden truncate text-[10px] text-text-3 sm:block">{item.caption}</span>
                        </span>
                        {count > 0 ? (
                          <span className="shrink-0 rounded-full bg-brand/12 px-1.5 text-[10px] font-bold text-brand">{count}</span>
                        ) : null}
                      </button>
                    );
                  })}
                </nav>
              ) : null}

              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
                {query ? (
                  <div className="grid gap-3">
                    <p className="text-[11px] leading-relaxed text-text-3">
                      {results.length > 0
                        ? `Найдено настроек: ${results.length}. Показаны только подходящие поля.`
                        : "Ничего не нашлось. Попробуй другое слово — например «хэштеги», «тон» или «цена»."}
                    </p>
                    <div className="grid gap-4 sm:grid-cols-2">{results.map(renderField)}</div>
                  </div>
                ) : tab === "quick" ? (
                  <div className="grid gap-4">
                    <AutomaticSettingsAction
                      pending={automaticSelectionPending && automatic}
                      saved={automaticSaved}
                      saving={saving}
                      onSelect={useAutomaticQuickSettings}
                    />

                    <div className="grid gap-3.5 sm:grid-cols-2">
                      {POST_SETTINGS_FIELDS.filter(
                        (field) => field.simple && !isTechnicalField(field) && (!field.visibleWhen || field.visibleWhen(settings)),
                      ).map(renderField)}
                    </div>

                    <div className="rounded-md border border-line bg-surface px-3.5 py-3">
                      <p className="text-[11px] font-extrabold text-text">Что получится</p>
                      <p className="mt-1 text-[11px] leading-relaxed text-text-2">{summary}</p>
                    </div>

                    <p className="text-[11px] leading-relaxed text-text-3">
                      Здесь только то, что чаще всего меняет результат. Все остальные{" "}
                      {visibleCount - POST_SETTINGS_FIELDS.filter((field) => field.simple).length} настроек — во вкладке «Все настройки» или
                      через поиск. Свои формулировки, точные числа и доказательства тоже там.
                    </p>
                  </div>
                ) : (
                  <div className="grid gap-4">
                    <AutomaticSettingsAction
                      pending={automaticSelectionPending && automatic}
                      saved={automaticSaved}
                      saving={saving}
                      advanced
                      onSelect={useAutomaticQuickSettings}
                    />

                    <section aria-label={group.title} className="grid gap-3">
                      <header>
                        <h3 className="text-[13px] font-extrabold text-text">{group.title}</h3>
                        <p className="mt-0.5 text-[11px] leading-relaxed text-text-3">{group.lead}</p>
                      </header>
                      <div className="grid gap-3.5 sm:grid-cols-2">{fieldsForGroup(group.id, settings).map(renderField)}</div>
                      {fieldsForGroup(group.id, settings).length === 0 ? (
                        <p className="rounded-sm bg-surface-inset px-3 py-2.5 text-[11px] text-text-3">
                          В этом разделе сейчас нет применимых настроек — они появятся при других значениях.
                        </p>
                      ) : null}
                    </section>
                  </div>
                )}
              </div>
            </div>

            {/* ПОДВАЛ: конфликты, итог и действия */}
            <div className="border-t border-line bg-surface">
              {conflicts.length > 0 ? (
                <div
                  className={cn(
                    "mx-4 mt-3 rounded-sm px-3 py-2.5 text-[11px] leading-relaxed sm:mx-5",
                    blockers.length ? "bg-danger-soft text-danger-text" : "bg-info-soft text-info-text",
                  )}
                >
                  <p className="flex items-center gap-1.5 font-bold">
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                    {blockers.length > 0 ? `Генерация заблокирована: ${blockers.length}` : "Проверка брифа"}
                  </p>
                  <ul className="mt-1.5 grid gap-1">
                    {conflicts.map((item) => (
                      <li key={item.code}>• {item.message}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                {footerSummary}
                <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
                  {overridden.length > 0 ? (
                    <Button variant="ghost" size="sm" className="min-h-11 w-full sm:w-auto" disabled={saving} onClick={resetAllToAuto}>
                      <RotateCcw className="h-4 w-4" aria-hidden />
                      Сбросить к авто
                    </Button>
                  ) : null}
                  <div className="grid grid-cols-2 gap-2 sm:flex sm:gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="min-h-11 w-full sm:w-auto"
                      disabled={!hasPendingChanges || saving}
                      onClick={() => {
                        setDraft(persisted);
                        setAutomaticSelectionPending(false);
                        setOpen(false);
                        triggerRef.current?.focus();
                      }}
                    >
                      Отмена
                    </Button>
                    <Button
                      variant="brand"
                      size="sm"
                      className="min-h-11 w-full sm:w-auto"
                      disabled={!hasPendingChanges || saving}
                      onClick={() => {
                        onChange(settings);
                        setAutomaticSelectionPending(false);
                        setOpen(false);
                        triggerRef.current?.focus();
                      }}
                    >
                      <Check className="h-4 w-4" aria-hidden />
                      Сохранить настройки
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
