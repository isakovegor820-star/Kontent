"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Plus, SlidersHorizontal, Sparkles, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  POST_PRESETS,
  POST_TARGET_OPTIONS,
  POST_TARGET_RULES,
  applyPostPreset,
  buildPostSettingsSummary,
  normalizePostSettings,
  patchPostSettings,
  postLengthRange,
  resolvePostTarget,
  validatePostSettingsConflicts,
  type PostPresetId,
  type PostProof,
  type PostSettings,
} from "@/lib/post-settings";
import { cn } from "@/lib/utils";

type SettingsTab = "quick" | "advanced";

const selectClass =
  "mt-1.5 h-11 w-full rounded-sm border border-line bg-surface px-3 text-base font-medium text-text outline-none transition-colors hover:border-line-strong focus:border-brand focus:ring-2 focus:ring-brand/15 sm:text-[13px]";
const inputClass =
  "mt-1.5 min-h-11 w-full rounded-sm border border-line bg-surface px-3 py-2 text-base leading-relaxed text-text outline-none placeholder:text-text-3 transition-colors hover:border-line-strong focus:border-brand focus:ring-2 focus:ring-brand/15 sm:text-[13px]";

const GOALS = [
  ["auto", "Авто — по задаче"],
  ["reach", "Охват"],
  ["engagement", "Вовлечение"],
  ["sale", "Продажа"],
  ["traffic", "Трафик"],
  ["education", "Обучение"],
  ["announcement", "Анонс"],
  ["warmup", "Прогрев"],
] as const;

const LENGTHS = [
  ["auto", "Авто — по формату"],
  ["short", "Короткая"],
  ["medium", "Средняя"],
  ["long", "Длинная"],
  ["custom", "Точный диапазон"],
] as const;

const CTAS = [
  ["auto", "Авто — только при необходимости"],
  ["none", "Без призыва"],
  ["comment", "Комментарий"],
  ["save", "Сохранить"],
  ["share", "Поделиться"],
  ["subscribe", "Подписаться"],
  ["click", "Перейти по ссылке"],
  ["buy", "Купить / оставить заявку"],
  ["reply", "Ответить автору"],
  ["register", "Зарегистрироваться"],
  ["download", "Скачать материал"],
] as const;

const PROFANITY_MODES = [
  ["auto", "Как в настройках канала"],
  ["forbid", "Без мата"],
  ["masked", "Одно слово со звёздочками"],
  ["allow", "Без цензуры и лимита"],
] as const;

const AUDIENCE_PRESETS = [
  ["", "Из паспорта канала"],
  ["новая аудитория, которая ещё не знакома с брендом", "Новая аудитория"],
  ["подписчики, которые уже читают канал", "Текущие подписчики"],
  ["потенциальные клиенты, которые выбирают решение", "Потенциальные клиенты"],
  ["действующие клиенты", "Действующие клиенты"],
  ["новички в теме", "Новички в теме"],
  ["профессионалы и эксперты в теме", "Профессионалы и эксперты"],
] as const;

const EMOJI_MODES = [
  ["auto", "Авто — если уместно"],
  ["none", "Без эмодзи"],
  ["few", "Один эмодзи"],
  ["moderate", "От двух до трёх"],
  ["many", "От четырёх до восьми"],
  ["custom", "Точное количество · расширенно"],
] as const;

const HASHTAG_MODES = [
  ["auto", "Авто — по площадке"],
  ["none", "Без хэштегов"],
  ["custom", "Точное количество · расширенно"],
] as const;

function QuickGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="grid gap-3 rounded-md border border-line bg-surface-inset p-3 sm:grid-cols-2">
      <legend className="px-1 text-[12px] font-extrabold text-text">{title}</legend>
      {children}
    </fieldset>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[12px] font-bold text-text">{label}</span>
      {hint && <span className="ml-1.5 text-[10px] font-normal text-text-3">{hint}</span>}
      {children}
    </label>
  );
}

function SelectField({
  label,
  hint,
  value,
  onChange,
  options,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly (readonly [string, string])[];
}) {
  return (
    <Field label={label} hint={hint}>
      <div className="relative">
        <select value={value} onChange={(event) => onChange(event.target.value)} className={cn(selectClass, "appearance-none pr-9")}>
          {options.map(([id, option]) => <option key={id} value={id}>{option}</option>)}
        </select>
        <ChevronDown className="pointer-events-none absolute right-3 top-[calc(50%+3px)] h-4 w-4 -translate-y-1/2 text-text-3" aria-hidden />
      </div>
    </Field>
  );
}

function TextField({
  label,
  hint,
  value,
  placeholder,
  type = "text",
  inputMode,
  min,
  max,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  placeholder?: string;
  type?: "text" | "number";
  inputMode?: "text" | "numeric";
  min?: number;
  max?: number;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <input
        className={inputClass}
        type={type}
        inputMode={inputMode}
        min={min}
        max={max}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function ListField({
  label,
  hint,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string[];
  placeholder?: string;
  onChange: (value: string[]) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <textarea
        rows={2}
        className={cn(inputClass, "resize-y")}
        value={value.join("\n")}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value.split("\n").map((item) => item.trim()).filter(Boolean))}
      />
    </Field>
  );
}

function ToggleField({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (checked: boolean) => void; hint?: string }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-sm border border-line bg-surface px-3 py-2">
      <span>
        <span className="block text-[12px] font-bold text-text">{label}</span>
        {hint ? <span className="mt-0.5 block text-[10px] leading-snug text-text-3">{hint}</span> : null}
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-4 w-4 accent-brand" />
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="group rounded-md border border-line bg-surface">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3.5 text-[12px] font-extrabold text-text marker:content-none">
        {title}
        <ChevronRight className="h-4 w-4 shrink-0 text-text-3 transition-transform group-open:rotate-90" aria-hidden />
      </summary>
      <div className="grid gap-3 border-t border-line px-3.5 py-3.5 sm:grid-cols-2">{children}</div>
    </details>
  );
}

const proofTypes = [
  ["number", "Цифра"], ["statistic", "Статистика"], ["case", "Кейс"], ["review", "Отзыв"],
  ["quote", "Цитата"], ["experience", "Личный опыт"], ["research", "Исследование"],
  ["certificate", "Сертификат"], ["demo", "Демонстрация"], ["comparison", "Сравнение"], ["product_fact", "Факт о продукте"],
] as const;

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
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const proofSeq = useRef(0);
  const persisted = normalizePostSettings(value);
  const [draft, setDraft] = useState<PostSettings>(() => persisted);
  const settings = normalizePostSettings(draft);
  const dirty = JSON.stringify(settings) !== JSON.stringify(persisted);
  const target = resolvePostTarget(settings, network);
  const rule = POST_TARGET_RULES[target];
  const [minChars, maxChars] = postLengthRange(settings, network);
  const preset = POST_PRESETS.find((item) => item.id === settings.preset);
  const conflicts = validatePostSettingsConflicts(settings);
  const blockers = conflicts.filter((item) => item.severity === "error");
  const summary = buildPostSettingsSummary(settings, network);

  useEffect(() => {
    if (!open) return;
    const focusFrame = window.requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector<HTMLElement>(
          'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled])',
        )
        ?.focus();
    });
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
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
    setDraft(
      keepPreset
        ? normalizePostSettings({ ...settings, ...patch, preset: settings.preset })
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
    update({ proofs: settings.proofs.map((proof) => proof.id === id ? { ...proof, ...patch } : proof) });
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
  const quickAudienceOptions: readonly (readonly [string, string])[] = AUDIENCE_PRESETS.some(
    ([value]) => value === settings.audience,
  )
    ? AUDIENCE_PRESETS
    : [[settings.audience, "Свой сегмент · настроен в расширенном режиме"], ...AUDIENCE_PRESETS];

  const useAutomaticQuickSettings = () => {
    setDraft(normalizePostSettings({
      ...settings,
      target: "auto",
      preset: "auto",
      goal: "auto",
      mainIdea: "",
      audience: "",
      length: "auto",
      formality: "auto",
      address: "auto",
      energy: "auto",
      humor: "auto",
      language: "auto",
      emojiMode: "auto",
      hashtags: "auto",
      profanityMode: "auto",
      cta: "auto",
      similarityLevel: "moderate",
      requireNewAngle: true,
      qualityMode: "balanced",
      autoImprove: true,
      qualityThreshold: 8,
    }));
  };

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
            setOpen(true);
          }
        }}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="dialog"
        aria-label="Настройки публикации"
        className={cn(
          "inline-flex min-h-11 max-w-[190px] min-w-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5",
          "text-[12px] font-semibold text-text-2 transition-colors hover:bg-surface-2 hover:text-text",
          "disabled:pointer-events-none disabled:opacity-45",
          open && "bg-surface-2 text-text",
        )}
      >
        <SlidersHorizontal className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
        <span className="truncate">Настройки</span>
        {saving ? <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-brand" aria-label="Сохраняю" /> : null}
      </button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Настройки публикации"
          className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] z-50 w-auto overflow-hidden rounded-lg border border-line-strong bg-surface-2 shadow-lift sm:absolute sm:inset-x-auto sm:right-0 sm:bottom-[calc(100%+8px)] sm:w-[540px] sm:max-w-[calc(100vw-1.5rem)]"
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3.5">
            <div>
              <p className="text-[15px] font-extrabold text-text">Как написать публикацию</p>
              <p className="mt-1 text-[11px] leading-relaxed text-text-3">
                {rule.label} · целевой объём {minChars}–{maxChars} знаков
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-text-3">
                {!saving && !dirty && <Check className="h-3.5 w-3.5 text-success-text" aria-hidden />}
                {saving ? "Сохраняю…" : dirty ? "Есть изменения" : "Сохранено"}
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

          <div className="grid grid-cols-2 border-b border-line p-1.5" role="group" aria-label="Режим настроек публикации">
            {(["quick", "advanced"] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setTab(item)}
                aria-pressed={tab === item}
                className={cn(
                  "min-h-11 rounded-sm text-[12px] font-bold transition-colors",
                  tab === item ? "bg-surface-inset text-text" : "text-text-3 hover:text-text",
                )}
              >
                {item === "quick" ? "Быстрый выбор" : "Расширенно"}
              </button>
            ))}
          </div>

          <div className="max-h-[min(52dvh,540px)] overflow-y-auto overscroll-contain px-4 py-4">
            {tab === "quick" ? (
              <div className="grid gap-4">
                <div className="flex flex-col gap-3 rounded-md bg-surface-inset px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-[12px] font-extrabold text-text">Тему напиши сообщением в чате</p>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-text-3">Аврора возьмёт задачу из сообщения — дублировать её в настройках не нужно.</p>
                  </div>
                  <Button type="button" variant="outline" size="sm" className="min-h-11 shrink-0" onClick={useAutomaticQuickSettings}>
                    <Sparkles className="h-4 w-4" aria-hidden />
                    Выбрать всё автоматически
                  </Button>
                </div>

                <QuickGroup title="Основа публикации">
                  <div className="sm:col-span-2">
                    <SelectField label="Площадка и формат" value={settings.target} onChange={(next) => update({ target: next as PostSettings["target"] }, true)} options={targetOptions} />
                  </div>
                  <div className="sm:col-span-2">
                    <SelectField
                      label="Характер публикации"
                      hint="готовый набор настроек"
                      value={settings.preset}
                      onChange={(next) => {
                        if (next === "auto") setDraft(normalizePostSettings({ ...settings, preset: "auto" }));
                        else if (next !== "custom") setDraft(applyPostPreset(settings, next as Exclude<PostPresetId, "auto" | "custom">));
                      }}
                      options={presetOptions}
                    />
                    {preset && <p className="mt-1.5 text-[11px] leading-relaxed text-text-3">{preset.description}</p>}
                  </div>
                </QuickGroup>

                <QuickGroup title="Задача и аудитория">
                  <SelectField label="Цель" value={settings.goal} onChange={(next) => update({ goal: next as PostSettings["goal"] })} options={GOALS} />
                  <SelectField label="Длина" value={settings.length} onChange={(next) => update({ length: next as PostSettings["length"] })} options={LENGTHS} />
                  <div className="sm:col-span-2">
                    <SelectField label="Для кого" value={settings.audience} onChange={(next) => update({ audience: next })} options={quickAudienceOptions} />
                  </div>
                  {settings.length === "custom" && (
                    <p className="rounded-sm bg-surface px-3 py-2 text-[11px] leading-relaxed text-text-3 sm:col-span-2">
                      Сейчас: {settings.customMinChars ?? 300}–{settings.customMaxChars ?? 1200} знаков. Точный диапазон меняется во вкладке «Расширенно».
                    </p>
                  )}
                </QuickGroup>

                <QuickGroup title="Голос публикации">
                  <SelectField label="Тон" value={settings.formality} onChange={(next) => update({ formality: next as PostSettings["formality"] })} options={[["auto", "Из голоса канала"], ["casual", "Разговорный"], ["neutral", "Нейтральный"], ["formal", "Деловой"]]} />
                  <SelectField label="Обращение" value={settings.address} onChange={(next) => update({ address: next as PostSettings["address"] })} options={[["auto", "Из голоса канала"], ["ты", "На «ты»"], ["вы", "На «вы»"], ["neutral", "Без обращения"]]} />
                  <SelectField label="Энергия" value={settings.energy} onChange={(next) => update({ energy: next as PostSettings["energy"] })} options={[["auto", "Авто — по теме"], ["calm", "Спокойная"], ["balanced", "Сбалансированная"], ["high", "Высокая"]]} />
                  <SelectField label="Юмор" value={settings.humor} onChange={(next) => update({ humor: next as PostSettings["humor"] })} options={[["auto", "Если уместно"], ["none", "Без юмора"], ["light", "Лёгкий"], ["bold", "Смелый"]]} />
                  <SelectField label="Язык" value={settings.language} onChange={(next) => update({ language: next as PostSettings["language"] })} options={[["auto", "Язык сообщения"], ["ru", "Русский"], ["en", "Английский"]]} />
                  <SelectField label="Мат" value={settings.profanityMode} onChange={(next) => update({ profanityMode: next as PostSettings["profanityMode"] })} options={PROFANITY_MODES} />
                </QuickGroup>

                <QuickGroup title="Оформление">
                  <SelectField label="Эмодзи" value={settings.emojiMode} onChange={(next) => update({ emojiMode: next as PostSettings["emojiMode"] })} options={EMOJI_MODES} />
                  <SelectField label="Хэштеги" value={settings.hashtags} onChange={(next) => update({ hashtags: next as PostSettings["hashtags"] })} options={HASHTAG_MODES} />
                </QuickGroup>

                <QuickGroup title="Финальный результат">
                  <SelectField label="Призыв к действию" value={settings.cta} onChange={(next) => update({ cta: next as PostSettings["cta"] })} options={CTAS} />
                  <SelectField label="Похожесть с прошлыми постами" value={settings.similarityLevel} onChange={(next) => update({ similarityLevel: next as PostSettings["similarityLevel"], requireNewAngle: next !== "allow" })} options={[["strict", "Не допускать похожие"], ["moderate", "Избегать повторов"], ["allow", "Повторы допустимы"]]} />
                  <div className="sm:col-span-2">
                    <SelectField label="Качество" value={settings.qualityMode} onChange={(next) => update({ qualityMode: next as PostSettings["qualityMode"] })} options={[["fast", "Быстро + обязательная проверка"], ["balanced", "Черновик и редактура"], ["maximum", "Максимум доступных исправлений"]]} />
                  </div>
                </QuickGroup>

                <p className="text-[11px] leading-relaxed text-text-3">
                  Готово: здесь всё выбирается из списка. Перед показом Аврора проверит выбранные правила и сама исправит нарушения. Свои формулировки, точные числа и доказательства доступны во вкладке «Расширенно».
                </p>

                <div className="rounded-sm bg-surface-inset px-3 py-2.5 text-[11px] leading-relaxed text-text-3">
                  Один запуск возвращает одну чистую публикацию. Дополнительный вариант создаётся кнопкой «Ещё вариант», поэтому версии не смешиваются в одном тексте.
                </div>

                {conflicts.length > 0 && (
                  <div className={cn("rounded-sm px-3 py-2.5 text-[11px] leading-relaxed", blockers.length ? "bg-danger-soft text-danger-text" : "bg-info-soft text-info-text") }>
                    <p className="flex items-center gap-1.5 font-bold"><AlertTriangle className="h-3.5 w-3.5" aria-hidden /> Проверка брифа</p>
                    <ul className="mt-1.5 grid gap-1">
                      {conflicts.map((item) => <li key={item.code}>• {item.message}</li>)}
                    </ul>
                  </div>
                )}

                <div className="rounded-sm border border-line bg-surface px-3 py-2.5">
                  <p className="text-[11px] font-extrabold text-text">Кратко</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-text-3">{summary}</p>
                </div>
              </div>
            ) : (
              <div className="grid gap-5">
                <Section title="Задача поста">
                  <TextField label="Главная мысль" value={settings.mainIdea} onChange={(next) => update({ mainIdea: next })} />
                  <SelectField label="Длина" value={settings.length} onChange={(next) => update({ length: next as PostSettings["length"] })} options={LENGTHS} />
                  {settings.length === "custom" && (
                    <>
                      <TextField label="От, знаков" type="number" inputMode="numeric" min={1} max={rule.hardLimit} value={String(settings.customMinChars ?? 300)} onChange={(next) => update({ customMinChars: Number(next) })} />
                      <TextField label="До, знаков" type="number" inputMode="numeric" min={1} max={rule.hardLimit} value={String(settings.customMaxChars ?? 1200)} onChange={(next) => update({ customMaxChars: Number(next) })} />
                    </>
                  )}
                  <TextField label="Что читатель должен понять" value={settings.readerUnderstanding} onChange={(next) => update({ readerUnderstanding: next })} />
                  <SelectField label="Что должен почувствовать" value={settings.desiredFeeling} onChange={(next) => update({ desiredFeeling: next as PostSettings["desiredFeeling"] })} options={[
                    ["auto", "Авто"], ["interest", "Интерес"], ["trust", "Доверие"], ["desire", "Желание"], ["urgency", "Срочность"], ["relief", "Облегчение"], ["inspiration", "Вдохновение"],
                  ]} />
                  <TextField label="Что должен сделать" value={settings.readerAction} onChange={(next) => update({ readerAction: next })} />
                  <SelectField label="Главная метрика" value={settings.primaryMetric} onChange={(next) => update({ primaryMetric: next as PostSettings["primaryMetric"] })} options={[
                    ["auto", "Авто"], ["readthrough", "Дочитывания"], ["saves", "Сохранения"], ["comments", "Комментарии"], ["clicks", "Переходы"], ["leads", "Заявки"], ["sales", "Продажи"],
                  ]} />
                  <SelectField label="Количество смыслов" value={settings.messageCount} onChange={(next) => update({ messageCount: next as PostSettings["messageCount"] })} options={[
                    ["one", "Один основной"], ["one_plus", "Основной + дополнительный"], ["several", "Несколько"],
                  ]} />
                  <ToggleField label="Добавлять вывод" checked={settings.includeConclusion} onChange={(next) => update({ includeConclusion: next })} />
                </Section>

                <Section title="Продукт и оффер">
                  <SelectField label="Тип предложения" value={settings.promotionType} onChange={(next) => update({ promotionType: next as PostSettings["promotionType"] })} options={[
                    ["auto", "Авто"], ["product", "Продукт"], ["service", "Услуга"], ["event", "Мероприятие"], ["personal_brand", "Личный бренд"], ["lead_magnet", "Бесплатный материал"],
                  ]} />
                  <TextField label="Что продвигаем" value={settings.promotionName} onChange={(next) => update({ promotionName: next })} />
                  <TextField label="Конкретное предложение" value={settings.offer} onChange={(next) => update({ offer: next })} />
                  <TextField label="Главная выгода" value={settings.mainBenefit} onChange={(next) => update({ mainBenefit: next })} />
                  <TextField label="Главное отличие" value={settings.differentiation} onChange={(next) => update({ differentiation: next })} />
                  <TextField label="Цена" hint="или «не указывать»" value={settings.price} onChange={(next) => update({ price: next })} />
                  <TextField label="Ссылка или место обращения" value={settings.offerDestination} onChange={(next) => update({ offerDestination: next })} />
                  <SelectField label="Интенсивность продажи" value={settings.salesIntensity} onChange={(next) => update({ salesIntensity: next as PostSettings["salesIntensity"] })} options={[
                    ["native", "Нативная"], ["soft", "Мягкая"], ["confident", "Уверенная"], ["direct", "Прямая"],
                  ]} />
                  <SelectField label="Когда показать продукт" value={settings.productReveal} onChange={(next) => update({ productReveal: next as PostSettings["productReveal"] })} options={[
                    ["immediately", "Сразу"], ["after_problem", "После проблемы"], ["near_end", "Ближе к концу"], ["cta_only", "Только в призыве"],
                  ]} />
                </Section>

                <Section title="Мотивация аудитории">
                  <TextField label="Сегмент аудитории" value={settings.audience} onChange={(next) => update({ audience: next })} />
                  <TextField label="Ситуация читателя" value={settings.readerSituation} onChange={(next) => update({ readerSituation: next })} />
                  <TextField label="Главная проблема" value={settings.audienceProblem} onChange={(next) => update({ audienceProblem: next })} />
                  <TextField label="Желаемый результат" value={settings.desiredResult} onChange={(next) => update({ desiredResult: next })} />
                  <TextField label="Эмоциональное желание" value={settings.emotionalDesire} onChange={(next) => update({ emotionalDesire: next })} />
                  <TextField label="Главный страх" value={settings.primaryFear} onChange={(next) => update({ primaryFear: next })} />
                  <TextField label="Барьер" value={settings.barrier} onChange={(next) => update({ barrier: next })} />
                  <TextField label="Основное возражение" value={settings.objection} onChange={(next) => update({ objection: next })} />
                  <TextField label="Неудачные попытки" value={settings.failedAttempts} onChange={(next) => update({ failedAttempts: next })} />
                  <TextField label="Текущая альтернатива" value={settings.currentAlternative} onChange={(next) => update({ currentAlternative: next })} />
                  <TextField label="Триггер покупки" value={settings.purchaseTrigger} onChange={(next) => update({ purchaseTrigger: next })} />
                  <TextField label="Критерий выбора" value={settings.choiceCriterion} onChange={(next) => update({ choiceCriterion: next })} />
                  <SelectField label="Уровень доверия" value={settings.trustLevel} onChange={(next) => update({ trustLevel: next as PostSettings["trustLevel"] })} options={[
                    ["auto", "Авто"], ["cold", "Холодная"], ["familiar", "Знакомая"], ["warm", "Тёплая"], ["customer", "Клиент"],
                  ]} />
                  <TextField label="Язык аудитории" value={settings.audienceLanguage} onChange={(next) => update({ audienceLanguage: next })} />
                  <TextField label="Не наша аудитория" value={settings.excludedAudience} onChange={(next) => update({ excludedAudience: next })} />
                </Section>

                <Section title={`Доказательства · ${settings.proofs.filter((proof) => proof.text).length}`}>
                  <SelectField label="Проверка фактов" hint="при отключении потребуется ручная проверка перед публикацией" value={settings.factStrictness} onChange={(next) => update({ factStrictness: next as PostSettings["factStrictness"] })} options={[
                    ["off", "Отключена"], ["verified", "Только подтверждённые"], ["verified_inference", "Факты + осторожные выводы"], ["general", "Общие рассуждения"], ["creative_no_new_facts", "Креативно, без новых фактов"],
                  ]} />
                  <SelectField label="Если данных недостаточно" value={settings.missingFactsMode} onChange={(next) => update({ missingFactsMode: next as PostSettings["missingFactsMode"] })} options={[
                    ["ask", "Задать вопрос"], ["omit", "Не использовать утверждение"], ["neutral", "Написать нейтрально"], ["placeholder", "Оставить место для заполнения"],
                  ]} />
                  <div className="grid gap-3 sm:col-span-2">
                    {settings.proofs.map((proof, index) => (
                      <div key={proof.id} className="rounded-sm border border-line bg-surface-2 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-[11px] font-extrabold text-text">Доказательство {index + 1}</p>
                          <button type="button" onClick={() => removeProof(proof.id)} className="grid h-11 w-11 place-items-center rounded-full text-text-3 hover:bg-danger-soft hover:text-danger-text" aria-label={`Удалить доказательство ${index + 1}`}><Trash2 className="h-3.5 w-3.5" /></button>
                        </div>
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <SelectField label="Тип" value={proof.type} onChange={(next) => updateProof(proof.id, { type: next as PostProof["type"] })} options={proofTypes} />
                          <TextField label="Дата актуальности" value={proof.validAt} onChange={(next) => updateProof(proof.id, { validAt: next })} />
                          <div className="sm:col-span-2"><TextField label="Само доказательство" value={proof.text} onChange={(next) => updateProof(proof.id, { text: next })} /></div>
                          <div className="sm:col-span-2"><TextField label="Источник" value={proof.source} onChange={(next) => updateProof(proof.id, { source: next })} /></div>
                          <ToggleField label="Использовать обязательно" checked={proof.required} onChange={(next) => updateProof(proof.id, { required: next })} />
                          <ToggleField label="Можно указать имя" checked={proof.allowClientName} onChange={(next) => updateProof(proof.id, { allowClientName: next })} />
                          <ToggleField label="Можно перефразировать" checked={proof.allowParaphrase} onChange={(next) => updateProof(proof.id, { allowParaphrase: next })} />
                        </div>
                      </div>
                    ))}
                    <button type="button" onClick={addProof} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-sm border border-dashed border-line-strong px-3 text-[12px] font-bold text-text-2 hover:bg-surface-inset"><Plus className="h-4 w-4" /> Добавить доказательство</button>
                  </div>
                </Section>

                <Section title="Механика продажи">
                  <SelectField label="Угол подачи" value={settings.salesAngle} onChange={(next) => update({ salesAngle: next as PostSettings["salesAngle"] })} options={[
                    ["auto", "Авто"], ["problem", "Через проблему"], ["desired_result", "Через желаемый результат"], ["mistake", "Через ошибку"], ["lost_opportunity", "Через потерянную возможность"], ["saving", "Через экономию"], ["speed", "Через скорость"], ["simplicity", "Через простоту"], ["safety", "Через безопасность"], ["status", "Через статус"], ["novelty", "Через новизну"], ["comparison", "Через сравнение"], ["case", "Через кейс"], ["objection", "Через возражение"], ["demo", "Через демонстрацию"], ["personal_story", "Через личную историю"],
                  ]} />
                  <SelectField label="Формула убеждения" value={settings.persuasionFormula} onChange={(next) => update({ persuasionFormula: next as PostSettings["persuasionFormula"] })} options={[
                    ["auto", "Авто"], ["aida", "Внимание → интерес → желание → действие"], ["pas", "Проблема → усиление → решение"], ["problem_consequence_solution", "Проблема → последствия → решение"], ["before_after_bridge", "До → после → мост"], ["story_insight_offer", "История → вывод → предложение"], ["objection_proof_offer", "Возражение → доказательство → предложение"], ["mistake_approach_product", "Ошибка → подход → продукт"], ["result_mechanism_cta", "Результат → механизм → призыв"], ["alternatives", "Сравнение альтернатив"], ["demo_benefit_action", "Демонстрация → выгода → действие"],
                  ]} />
                  <TextField label="Какое возражение закрыть" value={settings.objectionToHandle} onChange={(next) => update({ objectionToHandle: next })} />
                  <SelectField label="Сколько доказательств" value={settings.proofCount} onChange={(next) => update({ proofCount: next as PostSettings["proofCount"] })} options={[["auto", "Авто"], ["0", "0"], ["1", "1"], ["2", "2"], ["3_plus", "3 и более"]]} />
                  <SelectField label="Указывать цену" value={settings.priceMode} onChange={(next) => update({ priceMode: next as PostSettings["priceMode"] })} options={[["auto", "Если уместно"], ["required", "Обязательно"], ["never", "Не указывать"]]} />
                  <SelectField label="Уровень давления" value={settings.salesPressure} onChange={(next) => update({ salesPressure: next as PostSettings["salesPressure"] })} options={[["soft", "Без давления"], ["neutral", "Уверенный"], ["direct", "Прямой"]]} />
                  <SelectField label="Дефицит" value={settings.scarcity} onChange={(next) => update({ scarcity: next as PostSettings["scarcity"] })} options={[["none", "Не использовать"], ["real_quantity", "Реальное ограничение количества"]]} />
                  <SelectField label="Срочность" value={settings.urgency} onChange={(next) => update({ urgency: next as PostSettings["urgency"] })} options={[["none", "Без срочности"], ["deadline", "Реальный дедлайн"], ["event", "Событие"], ["price_increase", "Повышение цены"], ["enrollment_end", "Окончание набора"]]} />
                  {(settings.urgency !== "none" || settings.scarcity !== "none") && <TextField label="Реальная причина" hint="без неё генерация будет остановлена" value={settings.urgencyReason} onChange={(next) => update({ urgencyReason: next })} />}
                  <SelectField label="Снижение риска" value={settings.riskReducer} onChange={(next) => update({ riskReducer: next as PostSettings["riskReducer"] })} options={[["none", "Не использовать"], ["guarantee", "Гарантия"], ["trial", "Пробный период"], ["consultation", "Бесплатная консультация"], ["refund", "Возврат"], ["demo", "Демонстрация"]]} />
                </Section>

                <Section title="Призыв к действию">
                  <SelectField label="Основное действие" value={settings.cta} onChange={(next) => update({ cta: next as PostSettings["cta"] })} options={CTAS} />
                  <TextField label="Конкретная формулировка" value={settings.ctaWording} onChange={(next) => update({ ctaWording: next })} />
                  <TextField label="Куда ведём" value={settings.ctaDestination} onChange={(next) => update({ ctaDestination: next })} />
                  <TextField label="Что будет после действия" value={settings.ctaOutcome} onChange={(next) => update({ ctaOutcome: next })} />
                  <TextField label="Кодовое слово" value={settings.ctaCodeword} onChange={(next) => update({ ctaCodeword: next })} />
                  <SelectField label="Второй призыв" value={settings.secondaryCta} onChange={(next) => update({ secondaryCta: next as PostSettings["secondaryCta"] })} options={CTAS} />
                  <SelectField label="Сила призыва" value={settings.ctaStrength} onChange={(next) => update({ ctaStrength: next as PostSettings["ctaStrength"] })} options={[["soft", "Мягкая"], ["neutral", "Ясная"], ["direct", "Прямая"]]} />
                  <SelectField label="Позиция призыва" value={settings.ctaPlacement} onChange={(next) => update({ ctaPlacement: next as PostSettings["ctaPlacement"] })} options={[["natural", "По смыслу"], ["end", "В конце"]]} />
                  <SelectField label="Повторять призыв" value={String(settings.ctaRepeats)} onChange={(next) => update({ ctaRepeats: Number(next) as 1 | 2 })} options={[["1", "Один раз"], ["2", "Два раза"]]} />
                  <ToggleField label="Добавлять причину действовать" checked={settings.ctaAddReason} onChange={(next) => update({ ctaAddReason: next })} />
                  <ToggleField label="Указывать следующий шаг" checked={settings.ctaNextStep} onChange={(next) => update({ ctaNextStep: next })} />
                </Section>

                <Section title="Контекст публикации">
                  <SelectField label="Тип трафика" value={settings.trafficType} onChange={(next) => update({ trafficType: next as PostSettings["trafficType"] })} options={[["auto", "Авто"], ["organic", "Органический"], ["paid", "Рекламный"]]} />
                  <SelectField label="Температура аудитории" value={settings.audienceTemperature} onChange={(next) => update({ audienceTemperature: next as PostSettings["audienceTemperature"] })} options={[["auto", "Авто"], ["cold", "Холодная"], ["warm", "Тёплая"], ["hot", "Горячая"]]} />
                  <SelectField label="Этап воронки" value={settings.funnelStage} onChange={(next) => update({ funnelStage: next as PostSettings["funnelStage"] })} options={[["auto", "Авто"], ["awareness", "Знакомство"], ["problem", "Проблема"], ["solution", "Решение"], ["trust", "Доверие"], ["objection", "Возражение"], ["offer", "Предложение"], ["close", "Завершение"]]} />
                  <SelectField label="Тип касания" value={settings.touchType} onChange={(next) => update({ touchType: next as PostSettings["touchType"] })} options={[["auto", "Авто"], ["first", "Первое"], ["repeat", "Повторное"], ["final", "Финальное"]]} />
                  <TextField label="Кампания" value={settings.campaign} onChange={(next) => update({ campaign: next })} />
                  <SelectField label="Серия постов" value={settings.seriesStage} onChange={(next) => update({ seriesStage: next as PostSettings["seriesStage"] })} options={[["none", "Нет"], ["start", "Начало"], ["middle", "Середина"], ["finish", "Завершение"]]} />
                  <TextField label="Что было до этого" value={settings.previousPost} onChange={(next) => update({ previousPost: next })} />
                  <TextField label="Что будет дальше" value={settings.nextPost} onChange={(next) => update({ nextPost: next })} />
                  <TextField label="Что аудитория уже знает" value={settings.audienceKnows} onChange={(next) => update({ audienceKnows: next })} />
                  <TextField label="Что нельзя раскрывать" value={settings.confidential} onChange={(next) => update({ confidential: next })} />
                  <TextField label="Дата или событие" value={settings.eventDate} onChange={(next) => update({ eventDate: next })} />
                  <SelectField label="Актуальность" value={settings.relevance} onChange={(next) => update({ relevance: next as PostSettings["relevance"] })} options={[["evergreen", "Вечнозелёный"], ["temporary", "Временный"], ["news", "Новостной"]]} />
                </Section>

                <Section title="Оригинальность">
                  <SelectField label="Глубина сравнения" value={settings.originalityDepth} onChange={(next) => update({ originalityDepth: next as PostSettings["originalityDepth"] })} options={[["10", "Последние 10"], ["30", "Последние 30"], ["100", "Последние 100"], ["all", "Все доступные"]]} />
                  <SelectField label="Максимальная похожесть" value={settings.similarityLevel} onChange={(next) => update({ similarityLevel: next as PostSettings["similarityLevel"] })} options={[["strict", "Строгая"], ["moderate", "Умеренная"], ["allow", "Повторы допустимы"]]} />
                  <ToggleField label="Запрещать шаблонные фразы ИИ" checked={settings.blockAiCliches} onChange={(next) => update({ blockAiCliches: next })} />
                  <ToggleField label="Запрещать общие фразы" checked={settings.blockGenericPhrases} onChange={(next) => update({ blockGenericPhrases: next })} />
                  <ToggleField label="Требовать конкретный пример" checked={settings.requireConcreteExample} onChange={(next) => update({ requireConcreteExample: next })} />
                  <ToggleField label="Требовать новый угол" checked={settings.requireNewAngle} onChange={(next) => update({ requireNewAngle: next })} />
                  <ToggleField label="Показывать похожие посты" checked={settings.showSimilarPosts} onChange={(next) => update({ showSimilarPosts: next })} hint="Показывает до трёх ближайших совпадений из истории канала." />
                  <div className="sm:col-span-2">
                    <p className="mb-2 text-[12px] font-bold text-text">Не повторять</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {([[
                        "hooks", "Начала постов"], ["cta", "Призывы"], ["stories", "Истории"], ["examples", "Примеры"], ["structure", "Структуру"], ["phrases", "Ключевые формулировки"],
                      ] as const).map(([id, label]) => <ToggleField key={id} label={label} checked={settings.avoidRepetitions.includes(id)} onChange={(checked) => update({ avoidRepetitions: checked ? [...settings.avoidRepetitions, id] : settings.avoidRepetitions.filter((item) => item !== id) })} />)}
                    </div>
                  </div>
                </Section>

                <Section title="Контроль голоса автора">
                  <ListField label="Пиши примерно так" hint="примеры по одному на строку" value={settings.goodVoiceExamples} onChange={(next) => update({ goodVoiceExamples: next })} />
                  <ListField label="Никогда не пиши так" value={settings.badVoiceExamples} onChange={(next) => update({ badVoiceExamples: next })} />
                  <ListField label="Фирменные выражения" value={settings.signatureExpressions} onChange={(next) => update({ signatureExpressions: next })} />
                  <ListField label="Запрещённые выражения" value={settings.bannedExpressions} onChange={(next) => update({ bannedExpressions: next })} />
                  <SelectField label="Длина предложений" value={settings.sentenceLength} onChange={(next) => update({ sentenceLength: next as PostSettings["sentenceLength"] })} options={[["auto", "Авто"], ["short", "Короткие"], ["mixed", "Разный ритм"], ["long", "Развёрнутые"]]} />
                  <SelectField label="Степень копирования" value={settings.styleMatch} onChange={(next) => update({ styleMatch: next as PostSettings["styleMatch"] })} options={[["light", "Лёгкое сходство"], ["recognizable", "Узнаваемый голос"], ["maximum", "Максимально близко"]]} />
                  <SelectField label="Уровень сленга" value={settings.slangLevel} onChange={(next) => update({ slangLevel: next as PostSettings["slangLevel"] })} options={[["none", "Не использовать"], ["low", "Низкий"], ["medium", "Средний"], ["high", "Высокий"]]} />
                  <SelectField label="Мат" hint="Настройка текущего поста" value={settings.profanityMode} onChange={(next) => update({ profanityMode: next as PostSettings["profanityMode"] })} options={PROFANITY_MODES} />
                  <SelectField label="Уровень метафор" value={settings.metaphorLevel} onChange={(next) => update({ metaphorLevel: next as PostSettings["metaphorLevel"] })} options={[["none", "Не использовать"], ["low", "Низкий"], ["medium", "Средний"], ["high", "Высокий"]]} />
                  <SelectField label="Англицизмы" value={settings.anglicisms} onChange={(next) => update({ anglicisms: next as PostSettings["anglicisms"] })} options={[["none", "Не использовать"], ["low", "Редко"], ["medium", "Умеренно"], ["high", "Свободно"]]} />
                  <SelectField label="Риторические вопросы" value={settings.rhetoricalQuestions} onChange={(next) => update({ rhetoricalQuestions: next as PostSettings["rhetoricalQuestions"] })} options={[["none", "Запрещены"], ["low", "Редко"], ["medium", "Умеренно"], ["high", "Допустимы"]]} />
                  <SelectField label="Уровень провокации" value={settings.provocationLevel} onChange={(next) => update({ provocationLevel: next as PostSettings["provocationLevel"] })} options={[["none", "Без провокации"], ["low", "Низкий"], ["medium", "Средний"], ["high", "Высокий без хамства"]]} />
                  <TextField label="Пунктуация" hint="тире, скобки, многоточия" value={settings.punctuationNotes} onChange={(next) => update({ punctuationNotes: next })} />
                  <ListField label="Никогда не начинать" value={settings.neverStart} onChange={(next) => update({ neverStart: next })} />
                  <ListField label="Никогда не заканчивать" value={settings.neverEnd} onChange={(next) => update({ neverEnd: next })} />
                  <ToggleField label="Разрешить заглавные слова" checked={settings.capitalsAllowed} onChange={(next) => update({ capitalsAllowed: next })} />
                </Section>

                <Section title="Комплектация и качество">
                  <SelectField label="Режим качества" value={settings.qualityMode} onChange={(next) => update({ qualityMode: next as PostSettings["qualityMode"] })} options={[["fast", "Быстро + обязательная проверка"], ["balanced", "Черновик и редактура"], ["maximum", "Максимум доступных исправлений"]]} />
                  <SelectField label="Минимальная оценка" value={String(settings.qualityThreshold)} onChange={(next) => update({ qualityThreshold: Number(next) as PostSettings["qualityThreshold"] })} options={[["7", "7/10"], ["8", "8/10"], ["9", "9/10"]]} />
                  <ToggleField label="Дополнительно улучшать слабый текст" checked={settings.autoImprove} onChange={(next) => update({ autoImprove: next })} hint="Обязательные правила проверяются всегда." />
                  <SelectField label="Для «Ещё вариант»" value={settings.variantChange} onChange={(next) => update({ variantChange: next as PostSettings["variantChange"] })} options={[["full", "Полностью другая концепция"], ["hook", "Новое начало"], ["sales_angle", "Новый угол продажи"], ["structure", "Новая структура"], ["emotional", "Более эмоциональный"], ["expert", "Более экспертный"], ["native", "Более естественный"]]} />
                  <div className="sm:col-span-2">
                    <p className="mb-2 text-[12px] font-bold text-text">Что получить вместе с постом</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {([
                        ["hooks", "5 вариантов начала"], ["titles", "3 заголовка"], ["cover", "Текст на обложку"], ["first_comment", "Первый комментарий"], ["pinned_comment", "Закреплённый комментарий"], ["hashtags", "Хэштеги"], ["alt", "Описание изображения"], ["visual_brief", "Задание для изображения"], ["image_idea", "Идея изображения"], ["short_version", "Короткая версия"], ["stories", "Версия для историй"], ["cross_platform", "Другая площадка"], ["comment_replies", "Ответы на комментарии"], ["utm", "Ссылка с меткой"], ["discussion_question", "Вопрос для обсуждения"],
                      ] as const).map(([id, label]) => <ToggleField key={id} label={label} checked={settings.outputParts.includes(id)} onChange={(checked) => update({ outputParts: checked ? [...settings.outputParts, id] : settings.outputParts.filter((item) => item !== id) })} />)}
                    </div>
                  </div>
                </Section>

                <Section title="Аудитория и голос">
                  <SelectField label="Осведомлённость" value={settings.awareness} onChange={(next) => update({ awareness: next as PostSettings["awareness"] })} options={[
                    ["auto", "Авто — по контексту"], ["unaware", "Не знает о проблеме"], ["problem_aware", "Понимает проблему"], ["solution_aware", "Ищет решение"], ["product_aware", "Знает продукт"], ["ready", "Готова действовать"],
                  ]} />
                  <SelectField label="Язык" value={settings.language} onChange={(next) => update({ language: next as PostSettings["language"] })} options={[["auto", "Авто — язык задачи"], ["ru", "Русский"], ["en", "Английский"]]} />
                  <SelectField label="Формальность" value={settings.formality} onChange={(next) => update({ formality: next as PostSettings["formality"] })} options={[["auto", "Из голоса бренда"], ["casual", "Разговорно"], ["neutral", "Нейтрально"], ["formal", "Формально"]]} />
                  <SelectField label="Обращение" value={settings.address} onChange={(next) => update({ address: next as PostSettings["address"] })} options={[["auto", "Из голоса бренда"], ["ты", "На «ты»"], ["вы", "На «вы»"], ["neutral", "Без обращения"]]} />
                  <SelectField label="Энергия" value={settings.energy} onChange={(next) => update({ energy: next as PostSettings["energy"] })} options={[["auto", "Авто — по теме"], ["calm", "Спокойная"], ["balanced", "Сбалансированная"], ["high", "Высокая"]]} />
                  <SelectField label="Юмор" value={settings.humor} onChange={(next) => update({ humor: next as PostSettings["humor"] })} options={[["auto", "Только если уместно"], ["none", "Без юмора"], ["light", "Лёгкий"], ["bold", "Смелый без грубости"]]} />
                </Section>

                <Section title="Начало и структура">
                  <SelectField label="Тип начала" value={settings.hook} onChange={(next) => update({ hook: next as PostSettings["hook"] })} options={[["auto", "Авто — по содержанию"], ["insight", "Вывод"], ["benefit", "Польза"], ["problem", "Проблема"], ["story", "Сцена"], ["fact", "Факт"], ["question", "Вопрос"], ["contrast", "Контраст"], ["none", "Без отдельного начала"]]} />
                  <SelectField label="Структура" value={settings.structure} onChange={(next) => update({ structure: next as PostSettings["structure"] })} options={[["auto", "Авто — по материалу"], ["free", "Свободная"], ["explainer", "Объяснение"], ["problem_solution", "Проблема → решение"], ["story", "История"], ["list", "Список"], ["news", "Новость"], ["announcement", "Анонс"]]} />
                  <SelectField label="Абзацы" value={settings.paragraphs} onChange={(next) => update({ paragraphs: next as PostSettings["paragraphs"] })} options={[["auto", "Нативно площадке"], ["short", "1–2 предложения"], ["medium", "2–4 предложения"]]} />
                  <SelectField label="Списки" value={settings.lists} onChange={(next) => update({ lists: next as PostSettings["lists"] })} options={[["auto", "Только когда полезно"], ["avoid", "Не использовать"], ["prefer", "Предпочитать для шагов"], ["required", "Один список обязателен"]]} />
                </Section>

                <Section title="Оформление и хэштеги">
                  <SelectField label="Эмодзи" value={settings.emojiMode} onChange={(next) => update({ emojiMode: next as PostSettings["emojiMode"] })} options={EMOJI_MODES} />
                  {settings.emojiMode === "custom" && <TextField label="Точное количество эмодзи" type="number" inputMode="numeric" min={0} max={20} value={String(settings.emojiMax ?? 3)} onChange={(next) => update({ emojiMax: Number(next) })} />}
                  <SelectField label="Позиция эмодзи" value={settings.emojiPlacement} onChange={(next) => update({ emojiPlacement: next as PostSettings["emojiPlacement"] })} options={[["auto", "Нативно"], ["inline", "Внутри строк"], ["line_end", "В конце строк"], ["bullets", "Маркеры списка"]]} />
                  <SelectField label="Хэштеги" value={settings.hashtags} onChange={(next) => update({ hashtags: next as PostSettings["hashtags"] })} options={[["auto", "Авто — по формату"], ["none", "Без хэштегов"], ["custom", "Точное количество"]]} />
                  {settings.hashtags === "custom" && <TextField label="Количество хэштегов" type="number" inputMode="numeric" min={0} max={rule.platformHashtagMax} value={String(settings.hashtagCount ?? 3)} onChange={(next) => update({ hashtagCount: Number(next) })} />}
                  <SelectField label="Креативность" value={settings.creativity} onChange={(next) => update({ creativity: next as PostSettings["creativity"] })} options={[["low", "Низкая — точность"], ["balanced", "Сбалансированная"], ["high", "Высокая без выдумки"]]} />
                  <ListField label="Разрешённые эмодзи" hint="по одному на строку" value={settings.allowedEmojis} placeholder="✅\n💡" onChange={(next) => update({ allowedEmojis: next })} />
                  <ListField label="Запрещённые эмодзи" hint="по одному на строку" value={settings.forbiddenEmojis} placeholder="🔥\n🚀" onChange={(next) => update({ forbiddenEmojis: next })} />
                </Section>

                <Section title="Точные требования">
                  <ListField label="Ключевые слова" hint="по одному на строку" value={settings.keywords} onChange={(next) => update({ keywords: next })} />
                  <ListField label="Упоминания" hint="с @, без изменений" value={settings.mentions} onChange={(next) => update({ mentions: next })} />
                  <ListField label="Ссылки" hint="только подтверждённые" value={settings.links} onChange={(next) => update({ links: next })} />
                  <ListField label="Обязательные факты" hint="модель не вправе их менять" value={settings.requiredFacts} onChange={(next) => update({ requiredFacts: next })} />
                  <ListField label="Запрещённые слова" value={settings.forbiddenWords} onChange={(next) => update({ forbiddenWords: next })} />
                  <ListField label="Стоп-темы" value={settings.forbiddenTopics} onChange={(next) => update({ forbiddenTopics: next })} />
                </Section>

                <p className="rounded-sm bg-surface-inset px-3 py-2.5 text-[10px] leading-relaxed text-text-3 sm:col-span-2">
                  «Стиль текста» управляет манерой письма. Нативный шрифт Instagram, Telegram, VK и YouTube платформа изменить не может; псевдошрифты Unicode намеренно не используются.
                </p>
              </div>
            )}
          </div>
          <div className="flex flex-col gap-2 border-t border-line bg-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[11px] leading-relaxed text-text-3">
              {dirty ? "Изменения пока не применены к следующим публикациям." : "Все настройки публикации сохранены."}
            </p>
            <div className="flex shrink-0 gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="min-h-11"
                disabled={!dirty || saving}
                onClick={() => {
                  setDraft(persisted);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                Отмена
              </Button>
              <Button
                variant="brand"
                size="sm"
                className="min-h-11"
                disabled={!dirty || saving}
                onClick={() => {
                  onChange(settings);
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
      )}
    </div>
  );
}
