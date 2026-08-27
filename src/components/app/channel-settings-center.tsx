"use client";

import { createContext, useContext, useEffect, useRef, useState, type CSSProperties } from "react";
import { useSearchParams } from "next/navigation";
import {
  Check,
  ChevronDown,
  Copy,
  FileText,
  RotateCcw,
  Save,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Wand2,
} from "lucide-react";

import { ChannelPicker, channelName, useChannelChoice } from "@/components/app/channel-picker";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Badge, Card, Field, Input, Textarea, Toggle } from "@/components/ui/primitives";
import {
  AUTHOR_PROFILE_QUESTION_COUNT,
  AUTHOR_PROFILE_SECTIONS,
  RUBRICS,
  type AuthorProfileAnswers,
  type AuthorProfileQuestionId,
  type Brief,
} from "@/lib/brief";
import { QUALITY_PRESETS, presetQuality, type PostQuality } from "@/lib/post-quality.mjs";
import { PROFILE_FORMAT_OPTIONS } from "@/lib/profile";
import { analyzeStyleSamples, type StyleTrainingResult } from "@/lib/style-training";
import { useStore } from "@/lib/store";
import type { AutopilotSettings } from "@/lib/autopilot";
import { cn, plural } from "@/lib/utils";

type ChannelConfiguration = {
  brief: Brief;
  settings: AutopilotSettings;
};

type ChannelSettingsView = "content" | "autopilot";

const ChannelSettingsViewContext = createContext<ChannelSettingsView>("content");

const HUMOR_LABEL: Record<PostQuality["humor"], string> = {
  none: "без юмора",
  light: "лёгкий юмор",
  free: "можно свободно",
};

const ADDRESS_VALUES: PostQuality["address"][] = ["neutral", "вы", "ты"];
const ADDRESS_LABELS = ["без обращения", "на «вы»", "на «ты»"] as const;
const AUTHOR_VOICE_LABELS = ["безлично", "от лица «мы»", "от первого лица «я»"] as const;
const FORMAT_LABELS = ["сторителлинг", "список", "кейс", "вопрос — ответ", "новость", "мнение"] as const;
const HOOK_LABELS = ["вопрос", "шок-факт", "цифра", "интрига", "цитата"] as const;
const GOAL_LABELS = ["охват", "прогрев", "продажа", "репутация", "удержание"] as const;

function scaleLabel(value: number, labels: readonly string[]): string {
  const index = Math.min(labels.length - 1, Math.max(0, Math.round((value / 100) * (labels.length - 1))));
  return labels[index];
}

function energyText(value: number): string {
  if (value < 34) return "Спокойная и сдержанная, без суеты";
  if (value < 67) return "Ровная и разговорная, с естественным ритмом";
  return "Живая и энергичная, с коротким ритмом";
}

function RangeSetting({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  valueLabel,
  startLabel,
  endLabel,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  valueLabel: string;
  startLabel: string;
  endLabel: string;
  onChange: (value: number) => void;
}) {
  const progress = max === min ? 0 : ((value - min) / (max - min)) * 100;
  return (
    <div className="rounded-sm border border-line bg-surface/80 p-4 transition-[border-color,box-shadow] duration-200 hover:border-brand/25 hover:shadow-[0_10px_30px_rgba(79,70,229,.06)]">
      <div className="flex items-baseline justify-between gap-4">
        <label htmlFor={id} className="text-[13px] font-bold text-text">
          {label}
        </label>
        <output htmlFor={id} className="nums text-[13px] font-extrabold text-brand">
          {valueLabel}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={valueLabel}
        onInput={(event) => onChange(Number(event.currentTarget.value))}
        style={{ "--aurora-range-progress": `${progress}%` } as CSSProperties}
        className="aurora-range mt-3 h-8 w-full cursor-pointer"
      />
      <div className="flex justify-between gap-3 text-[11px] text-text-3">
        <span>{startLabel}</span>
        <span className="text-right">{endLabel}</span>
      </div>
    </div>
  );
}

function Segments<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; description?: string; disabled?: boolean }[];
  onChange: (value: T) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-[13px] font-semibold text-text-2">{label}</p>
      <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={label}>
        {options.map((option) => {
          const active = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={option.disabled}
              onClick={() => onChange(option.value)}
              className={cn(
                "min-h-11 rounded-sm border px-3 py-2 text-left transition-colors",
                active
                  ? "border-brand bg-info-soft text-info-text"
                  : "border-line bg-surface text-text-2 hover:border-brand/35 hover:text-text",
                option.disabled && "cursor-not-allowed opacity-45",
              )}
            >
              <span className="block text-[13px] font-bold">{option.label}</span>
              {option.description && (
                <span className="mt-0.5 block text-[11px] leading-snug opacity-75">
                  {option.description}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SettingsGroup({
  title,
  description,
  icon,
  defaultOpen = false,
  kind = "content",
  children,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  defaultOpen?: boolean;
  kind?: ChannelSettingsView;
  children: React.ReactNode;
}) {
  const view = useContext(ChannelSettingsViewContext);
  const [open, setOpen] = useState(defaultOpen);
  if (view !== kind) return null;
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="group border-b border-line last:border-b-0"
    >
      <summary className="flex cursor-pointer list-none items-start gap-3 px-5 py-5 sm:px-6">
        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-info-soft text-brand">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-extrabold text-text">{title}</span>
          <span className="mt-0.5 block text-[12px] leading-relaxed text-text-3">{description}</span>
        </span>
        <ChevronDown className="mt-2 h-4 w-4 shrink-0 text-text-3 transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="space-y-5 px-5 pb-6 sm:px-6">{children}</div>
    </details>
  );
}

function AuthorProfileQuestionnaire({
  answers,
  onChange,
}: {
  answers: AuthorProfileAnswers;
  onChange: (answers: AuthorProfileAnswers) => void;
}) {
  const filled = Object.values(answers).filter((answer) => answer?.trim()).length;
  const progress = Math.round((filled / AUTHOR_PROFILE_QUESTION_COUNT) * 100);

  const updateAnswer = (id: AuthorProfileQuestionId, value: string) => {
    const next = { ...answers };
    if (value.trim()) next[id] = value;
    else delete next[id];
    onChange(next);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-sm bg-info-soft p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-[14px] font-bold text-text">Заполните профиль один раз</p>
            <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-text-2">
              Аврора будет учитывать ответы во всех следующих постах этого канала. Можно заполнять постепенно и оставлять неподходящие вопросы пустыми.
            </p>
          </div>
          <span className="nums shrink-0 text-[13px] font-extrabold text-brand">
            {filled} из {AUTHOR_PROFILE_QUESTION_COUNT}
          </span>
        </div>
        <div
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface"
          role="progressbar"
          aria-label="Заполнение профиля автора"
          aria-valuemin={0}
          aria-valuemax={AUTHOR_PROFILE_QUESTION_COUNT}
          aria-valuenow={filled}
        >
          <div className="h-full rounded-full bg-brand" style={{ width: `${progress}%` }} />
        </div>
      </div>

      <div className="space-y-3">
        {AUTHOR_PROFILE_SECTIONS.map((section, sectionIndex) => (
          <AuthorProfileSection
            key={section.id}
            section={section}
            sectionIndex={sectionIndex}
            answers={answers}
            onAnswer={updateAnswer}
          />
        ))}
      </div>
    </div>
  );
}

function AuthorProfileSection({
  section,
  sectionIndex,
  answers,
  onAnswer,
}: {
  section: (typeof AUTHOR_PROFILE_SECTIONS)[number];
  sectionIndex: number;
  answers: AuthorProfileAnswers;
  onAnswer: (id: AuthorProfileQuestionId, value: string) => void;
}) {
  const [open, setOpen] = useState(sectionIndex === 0);
  const sectionFilled = section.questions.filter((question) => answers[question.id as AuthorProfileQuestionId]?.trim()).length;

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="group rounded-md border border-line bg-surface/75"
    >
      <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 px-4 py-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand marker:content-none">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-surface-inset text-[12px] font-extrabold text-brand">
          {sectionIndex + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-extrabold text-text">{section.title}</span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-text-3">{section.description}</span>
        </span>
        <span className="nums shrink-0 text-[11px] font-bold text-text-3">
          {sectionFilled}/{section.questions.length}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-text-3 transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="grid gap-5 px-4 pb-5 pt-2 lg:grid-cols-2">
        {section.questions.map((question) => {
          const id = `author-profile-${question.id}`;
          return (
            <Field
              key={question.id}
              label={`${question.number}. ${question.label}`}
              htmlFor={id}
              hint={question.hint}
            >
              <Textarea
                id={id}
                rows={3}
                maxLength={1600}
                value={answers[question.id as AuthorProfileQuestionId] ?? ""}
                onChange={(event) => onAnswer(question.id as AuthorProfileQuestionId, event.target.value)}
                placeholder="Напишите ответ…"
              />
            </Field>
          );
        })}
      </div>
    </details>
  );
}

function configurationSummary(data: ChannelConfiguration) {
  const { brief, settings } = data;
  const preset = QUALITY_PRESETS[brief.quality.preset]?.label ?? "Свой стиль";
  const address = brief.quality.address === "ты"
    ? "на «ты»"
    : brief.quality.address === "вы"
      ? "на «вы»"
      : "без обращения";
  return [
    preset,
    address,
    `${settings.post_frequency} ${plural(settings.post_frequency, "пост", "поста", "постов")} в неделю`,
    `${brief.quality.minChars}–${brief.quality.maxChars} знаков`,
    HUMOR_LABEL[brief.quality.humor],
    "с обязательным подтверждением",
  ];
}

export function ChannelSettingsCenter({ view = "content" }: { view?: ChannelSettingsView }) {
  const store = useStore();
  const requestedChannel = Number(useSearchParams().get("channel")) || null;
  const [picked, setPicked] = useState<number | null>(requestedChannel);
  const { tgChannels, channelId } = useChannelChoice(store.realChannels, picked);
  const [saved, setSaved] = useState<ChannelConfiguration | null>(null);
  const [draft, setDraft] = useState<ChannelConfiguration | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [styleText, setStyleText] = useState("");
  const [analysis, setAnalysis] = useState<StyleTrainingResult | null>(null);
  const [pendingChannel, setPendingChannel] = useState<number | null>(null);
  const [copyTarget, setCopyTarget] = useState<number | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);

  const dirty = Boolean(saved && draft && JSON.stringify(saved) !== JSON.stringify(draft));
  const activeChannel = tgChannels.find((channel) => channel.id === channelId) ?? null;

  /* eslint-disable react-hooks/set-state-in-effect -- загрузка поканального профиля при смене выбранного канала */
  useEffect(() => {
    if (!channelId) return;
    const controller = new AbortController();
    setLoading(true);
    setLoadError(false);
    fetch(`/api/settings/channel?channel=${channelId}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as ChannelConfiguration | null;
        if (!response.ok || !body?.brief || !body.settings) throw new Error("load_failed");
        setSaved(body);
        setDraft(body);
        setStyleText(body.brief.quality.styleExamples.join("\n---\n"));
        setAnalysis(null);
      })
      .catch((error) => {
        if ((error as Error)?.name !== "AbortError") setLoadError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [channelId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const setBrief = <K extends keyof Brief>(key: K, value: Brief[K]) => {
    setDraft((current) => current
      ? { ...current, brief: { ...current.brief, source: "manual", [key]: value } }
      : current);
  };
  const setQuality = <K extends keyof PostQuality>(key: K, value: PostQuality[K]) => {
    setDraft((current) => current
      ? {
          ...current,
          brief: {
            ...current.brief,
            source: "manual",
            quality: { ...current.brief.quality, preset: "custom", [key]: value },
          },
        }
      : current);
  };
  const setQualityPatch = (patch: Partial<PostQuality>) => {
    setDraft((current) => current
      ? {
          ...current,
          brief: {
            ...current.brief,
            source: "manual",
            quality: { ...current.brief.quality, ...patch, preset: "custom" },
          },
        }
      : current);
  };
  const setAutopilot = <K extends keyof AutopilotSettings>(key: K, value: AutopilotSettings[K]) => {
    setDraft((current) => current
      ? { ...current, settings: { ...current.settings, [key]: value } }
      : current);
  };

  const save = async () => {
    if (!draft || !channelId || saving) return;
    if (draft.brief.niche.trim().length < 3 || draft.brief.audience.trim().length < 3) {
      store.toast({
        kind: "info",
        title: "Не хватает двух ответов",
        body: "Заполни, о чём канал и для кого он — без этого Аврора начнёт писать слишком общо.",
      });
      return;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/settings/channel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId, brief: draft.brief, settings: draft.settings }),
      });
      const body = (await response.json().catch(() => null)) as
        | ({ ok?: boolean; error?: string } & Partial<ChannelConfiguration>)
        | null;
      if (!response.ok || !body?.ok || !body.brief || !body.settings) {
        const reason = body?.error === "incomplete"
            ? "Заполни тему канала и аудиторию."
            : "Сервер не подтвердил изменения. Черновик остался на экране.";
        throw new Error(reason);
      }
      const next = { brief: body.brief, settings: body.settings } as ChannelConfiguration;
      setSaved(next);
      setDraft(next);
      setStyleText(next.brief.quality.styleExamples.join("\n---\n"));
      store.toast({
        kind: "success",
        title: "Настройки сохранены",
        body: `Аврора обновила профиль «${activeChannel ? channelName(activeChannel) : "канала"}».`,
      });
    } catch (error) {
      store.toast({
        kind: "danger",
        title: "Настройки не сохранены",
        body: error instanceof Error ? error.message : "Попробуй ещё раз.",
      });
    } finally {
      setSaving(false);
    }
  };

  const analyze = () => {
    const result = analyzeStyleSamples(styleText);
    if (!result) {
      store.toast({
        kind: "info",
        title: "Нужен текст поста",
        body: "Вставь хотя бы один пост длиннее пары предложений. Несколько постов разделяй строкой ---.",
      });
      return;
    }
    setAnalysis(result);
  };

  const applyStyle = () => {
    if (!analysis) return;
    setDraft((current) => current
      ? {
          ...current,
          brief: {
            ...current.brief,
            source: "manual",
            quality: { ...current.brief.quality, ...analysis.patch, preset: "custom" },
          },
        }
      : current);
    store.toast({
      kind: "info",
      title: "Стиль добавлен в черновик",
      body: "Проверь остальные параметры и нажми «Сохранить настройки».",
    });
  };

  const copyConfiguration = async () => {
    if (!saved || !copyTarget) return;
    const target = tgChannels.find((channel) => channel.id === copyTarget);
    try {
      const response = await fetch("/api/settings/channel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelId: copyTarget,
          brief: { ...saved.brief, source: "manual" },
          settings: { ...saved.settings, enabled: false, mode: "confirm" },
        }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean } | null;
      if (!response.ok || !body?.ok) throw new Error("copy_failed");
      store.toast({
        kind: "success",
        title: "Профиль скопирован",
        body: `Для «${target ? channelName(target) : "канала"}» автопилот оставлен выключенным до проверки.`,
      });
    } catch {
      store.toast({ kind: "danger", title: "Не удалось скопировать профиль" });
    } finally {
      setCopyTarget(null);
      setCopyOpen(false);
    }
  };

  if (!store.realReady) {
    return <div className="skeleton h-72 rounded-lg" />;
  }
  if (!channelId) {
    return (
      <Card className="p-6">
        <p className="text-[16px] font-extrabold text-text">Сначала подключи Telegram-канал</p>
        <p className="mt-1 text-[14px] text-text-2">
          Голос, автопилот и правила публикаций сохраняются отдельно для каждого канала.
        </p>
      </Card>
    );
  }

  return (
    <ChannelSettingsViewContext.Provider value={view}>
    <div className="space-y-5" data-settings-dirty={dirty ? "true" : "false"}>
      <ChannelPicker
        channels={tgChannels}
        value={channelId}
        onChange={(next) => {
          if (dirty) setPendingChannel(next);
          else setPicked(next);
        }}
        label="Настраиваем канал"
      />

      {loading ? (
        <div className="skeleton h-72 rounded-lg" />
      ) : loadError || !draft || !saved ? (
        <Card className="p-6" role="alert">
          <p className="text-[15px] font-bold text-text">Не удалось загрузить настройки канала</p>
          <p className="mt-1 text-[13px] text-text-3">Обнови страницу — сохранённые настройки не изменились.</p>
        </Card>
      ) : (
        <>
          <Card className="overflow-hidden bg-[linear-gradient(135deg,rgba(238,242,255,.92),rgba(250,245,255,.88))]">
            <div className="flex flex-col gap-5 p-5 sm:p-6 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={saved.settings.enabled ? "success" : "neutral"}>
                    {saved.settings.enabled ? "Автопилот включён" : "Автопилот выключен"}
                  </Badge>
                  <Badge tone="brand">Сохранено на сервере</Badge>
                </div>
                <h2 className="mt-3 text-[20px] font-extrabold tracking-tight text-text">
                  {view === "autopilot" ? "Автопилот канала" : "Контент и стиль канала"}
                </h2>
                <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-text-2">
                  {view === "autopilot"
                    ? `План и обязательное подтверждение для «${activeChannel ? channelName(activeChannel) : "канала"}».`
                    : `Так Аврора понимает канал «${activeChannel ? channelName(activeChannel) : "Канал"}» и пишет для него.`}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {configurationSummary(saved).map((item) => <Badge key={item} tone="neutral">{item}</Badge>)}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                  <Settings2 className="h-4 w-4" aria-hidden />
                  Изменить
                </Button>
                {view === "content" && tgChannels.length > 1 && (
                  <Button variant="ghost" size="sm" onClick={() => setCopyOpen((current) => !current)}>
                    <Copy className="h-4 w-4" aria-hidden />
                    Скопировать
                  </Button>
                )}
              </div>
            </div>
            {view === "content" && copyOpen && (
              <div className="border-t border-line bg-surface/65 px-5 py-4 sm:px-6">
                <p className="text-[12px] font-bold text-text">В какой канал скопировать профиль?</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {tgChannels.filter((channel) => channel.id !== channelId).map((channel) => (
                    <Button key={channel.id} variant="soft" size="sm" onClick={() => setCopyTarget(channel.id)}>
                      {channelName(channel)}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </Card>

          <div ref={editorRef} className="scroll-mt-24">
          <Card className="overflow-hidden" as="section">
            <div className="border-b border-line px-5 py-5 sm:px-6">
              <div className="flex items-start gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-sm bg-info-soft text-brand">
                  <SlidersHorizontal className="h-5 w-5" aria-hidden />
                </span>
                <div>
                  <h2 className="text-[17px] font-extrabold text-text">
                    {view === "autopilot" ? "Как Аврора планирует" : "Как Аврора пишет"}
                  </h2>
                  <p className="mt-1 text-[13px] leading-relaxed text-text-2">
                    Изменения этого раздела остаются черновиком до отдельного сохранения.
                  </p>
                </div>
              </div>
            </div>

            <SettingsGroup
              title="О канале"
              description="Контекст, цель, роль автора и границы — основа каждого нового поста."
              icon={<FileText className="h-4 w-4" aria-hidden />}
              defaultOpen
            >
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Тема и ниша" required htmlFor="channel-niche" hint="Предметная область и конкретный фокус канала.">
                  <Textarea id="channel-niche" rows={3} required value={draft.brief.niche} onChange={(event) => setBrief("niche", event.target.value)} placeholder="Например: кофе и домашнее заваривание для небольших кухонь" />
                </Field>
                <Field label="Аудитория и её задача" required htmlFor="channel-audience" hint="Кто читает, что уже знает и какую проблему решает.">
                  <Textarea id="channel-audience" rows={3} required value={draft.brief.audience} onChange={(event) => setBrief("audience", event.target.value)} placeholder="Например: новички, которым нужна стабильная чашка без дорогого оборудования" />
                </Field>
                <Field label="Цель канала" htmlFor="channel-goal" hint="Результат, который должен поддерживать контент.">
                  <Textarea id="channel-goal" rows={3} value={draft.brief.goal} onChange={(event) => setBrief("goal", event.target.value)} placeholder="Например: растить доверие и продавать консультации" />
                </Field>
                <Field label="Роль и экспертиза автора" htmlFor="channel-author-role" hint="От чьего лица и на каком основании звучат рекомендации.">
                  <Textarea id="channel-author-role" rows={3} value={draft.brief.authorRole} onChange={(event) => setBrief("authorRole", event.target.value)} placeholder="Например: обжарщик и Q-грейдер с 10-летним опытом" />
                </Field>
                <Field label="Следующий шаг читателя" htmlFor="channel-cta" hint="Действие, ссылка, продукт или точка контакта.">
                  <Textarea id="channel-cta" rows={3} value={draft.brief.cta} onChange={(event) => setBrief("cta", event.target.value)} placeholder="Например: перейти в бот и записаться на консультацию" />
                </Field>
                <Field label="Запретные темы и обещания" htmlFor="channel-taboo" hint="Что нельзя утверждать, обещать или обсуждать.">
                  <Textarea id="channel-taboo" rows={3} value={draft.brief.taboo} onChange={(event) => setBrief("taboo", event.target.value)} placeholder="Например: не обещать гарантированный результат, не обсуждать политику" />
                </Field>
              </div>
              <div>
                <p className="mb-2 text-[13px] font-semibold text-text-2">Смысловые рубрики</p>
                <div className="flex flex-wrap gap-2">
                  {RUBRICS.map((rubric) => {
                    const active = draft.brief.rubrics.includes(rubric.label);
                    return (
                      <button
                        key={rubric.key}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setBrief(
                          "rubrics",
                          active
                            ? draft.brief.rubrics.filter((item) => item !== rubric.label)
                            : [...draft.brief.rubrics, rubric.label],
                        )}
                        className={cn(
                          "min-h-11 rounded-full border px-3 py-2 text-[13px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
                          active ? "border-brand bg-info-soft text-info-text" : "border-line bg-surface text-text-2 hover:border-brand/35",
                        )}
                      >
                        <span aria-hidden>{rubric.emoji}</span> {rubric.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <p className="mb-2 text-[13px] font-semibold text-text-2">Форматы публикаций</p>
                <div className="flex flex-wrap gap-2">
                  {PROFILE_FORMAT_OPTIONS.map((format) => {
                    const active = draft.brief.formats.includes(format);
                    return (
                      <button
                        key={format}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setBrief(
                          "formats",
                          active
                            ? draft.brief.formats.filter((item) => item !== format)
                            : [...draft.brief.formats, format].slice(0, 10),
                        )}
                        className={cn(
                          "min-h-11 rounded-full border px-3 py-2 text-[13px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
                          active ? "border-brand bg-info-soft text-info-text" : "border-line bg-surface text-text-2 hover:border-brand/35",
                        )}
                      >
                        {active && <Check className="mr-1 inline h-3.5 w-3.5" aria-hidden />}
                        {format}
                      </button>
                    );
                  })}
                </div>
              </div>
            </SettingsGroup>

            <SettingsGroup
              title={`Профиль автора · ${Object.values(draft.brief.profileAnswers).filter((answer) => answer?.trim()).length}/${AUTHOR_PROFILE_QUESTION_COUNT}`}
              description="26 вопросов об аудитории, темах, голосе, фактах, актуальности и биографии автора."
              icon={<Sparkles className="h-4 w-4" aria-hidden />}
            >
              <AuthorProfileQuestionnaire
                answers={draft.brief.profileAnswers}
                onChange={(profileAnswers) => setBrief("profileAnswers", profileAnswers)}
              />
            </SettingsGroup>

            <SettingsGroup
              title="Голос и стиль"
              description="Вставь свои посты — Аврора возьмёт манеру письма, но не превратит их факты в истину."
              icon={<Wand2 className="h-4 w-4" aria-hidden />}
              defaultOpen
            >
              <div className="rounded-sm bg-info-soft p-4">
                <div className="flex items-start gap-3">
                  <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-brand" aria-hidden />
                  <div>
                    <p className="text-[14px] font-bold text-text">Научи Аврору своему голосу</p>
                    <p className="mt-1 text-[12px] leading-relaxed text-text-2">
                      Один пост даст предварительный профиль. Для уверенного результата вставь 3–5 постов, разделяя их строкой <span className="font-mono">---</span>.
                    </p>
                  </div>
                </div>
              </div>
              <Textarea
                rows={8}
                value={styleText}
                onChange={(event) => {
                  setStyleText(event.target.value);
                  setAnalysis(null);
                }}
                placeholder={"Вставь сюда пост, который точно звучит как ты…\n\n---\n\nИ ещё один пост для более точного профиля"}
                aria-label="Примеры авторского стиля"
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="outline" size="sm" onClick={analyze}>
                  <Wand2 className="h-4 w-4" aria-hidden />
                  Разобрать стиль
                </Button>
                {draft.brief.quality.styleExamples.length > 0 && (
                  <span className="text-[12px] text-text-3">
                    В профиле: {draft.brief.quality.styleExamples.length} {plural(draft.brief.quality.styleExamples.length, "пример", "примера", "примеров")}
                  </span>
                )}
              </div>
              {analysis && (
                <div className="rounded-sm border border-brand/20 bg-surface p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[14px] font-bold text-text">Аврора увидела стиль</p>
                    <Badge tone={analysis.confidence === "low" ? "fire" : "success"}>
                      {analysis.confidence === "high" ? "высокая точность" : analysis.confidence === "medium" ? "хорошая основа" : "предварительно"}
                    </Badge>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {analysis.summary.map((item) => <Badge key={item} tone="neutral">{item}</Badge>)}
                  </div>
                  <p className="mt-3 text-[12px] leading-relaxed text-text-3">
                    Сохраняется только манера письма. Цены, имена, кейсы и обещания из этих постов не становятся подтверждёнными фактами.
                  </p>
                  <Button className="mt-4" variant="brand" size="sm" onClick={applyStyle}>
                    <Check className="h-4 w-4" aria-hidden />
                    Применить стиль к черновику
                  </Button>
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <RangeSetting
                  id="channel-address"
                  label="Обращение к аудитории"
                  min={0}
                  max={2}
                  value={ADDRESS_VALUES.indexOf(draft.brief.quality.address)}
                  valueLabel={ADDRESS_LABELS[ADDRESS_VALUES.indexOf(draft.brief.quality.address)]}
                  startLabel="без обращения"
                  endLabel="на «ты»"
                  onChange={(value) => setQuality("address", ADDRESS_VALUES[value])}
                />
                <RangeSetting
                  id="channel-author-voice"
                  label="Голос автора"
                  min={0}
                  max={2}
                  value={draft.brief.quality.authorVoice}
                  valueLabel={AUTHOR_VOICE_LABELS[draft.brief.quality.authorVoice]}
                  startLabel="безлично"
                  endLabel="личный голос"
                  onChange={(value) => setQuality("authorVoice", value)}
                />
                <RangeSetting
                  id="channel-energy"
                  label="Энергия текста"
                  min={0}
                  max={100}
                  value={draft.brief.quality.energyLevel}
                  valueLabel={scaleLabel(draft.brief.quality.energyLevel, ["спокойно", "сдержанно", "ровно", "живо", "максимум энергии"])}
                  startLabel="спокойно"
                  endLabel="энергично"
                  onChange={(value) => setQualityPatch({ energyLevel: value, energy: energyText(value) })}
                />
                <RangeSetting
                  id="channel-warmth"
                  label="Теплота"
                  min={0}
                  max={100}
                  value={draft.brief.quality.warmth}
                  valueLabel={scaleLabel(draft.brief.quality.warmth, ["холодно", "сдержанно", "доброжелательно", "тепло", "очень тепло"])}
                  startLabel="дистанция"
                  endLabel="эмпатия"
                  onChange={(value) => setQuality("warmth", value)}
                />
                <RangeSetting
                  id="channel-inspiration"
                  label="Вдохновение и надежда"
                  min={0}
                  max={100}
                  value={draft.brief.quality.inspiration}
                  valueLabel={`${draft.brief.quality.inspiration}/100`}
                  startLabel="нейтрально"
                  endLabel="вдохновляюще"
                  onChange={(value) => setQuality("inspiration", value)}
                />
                <RangeSetting
                  id="channel-provocation"
                  label="Провокационность"
                  min={0}
                  max={100}
                  value={draft.brief.quality.provocation}
                  valueLabel={`${draft.brief.quality.provocation}/100`}
                  startLabel="бережно"
                  endLabel="провокационно"
                  onChange={(value) => setQuality("provocation", value)}
                />
                <RangeSetting
                  id="channel-formality"
                  label="Стиль изложения"
                  min={0}
                  max={100}
                  value={draft.brief.quality.formality}
                  valueLabel={scaleLabel(draft.brief.quality.formality, ["разговорный", "живой", "публицистический", "деловой", "официальный"])}
                  startLabel="разговорно"
                  endLabel="делово"
                  onChange={(value) => setQuality("formality", value)}
                />
                <RangeSetting
                  id="channel-expertise"
                  label="Экспертность голоса"
                  min={0}
                  max={100}
                  value={draft.brief.quality.expertise}
                  valueLabel={scaleLabel(draft.brief.quality.expertise, ["друг", "помощник", "ментор", "эксперт", "ведущий эксперт"])}
                  startLabel="друг"
                  endLabel="эксперт"
                  onChange={(value) => setQuality("expertise", value)}
                />
                <RangeSetting
                  id="channel-humor"
                  label="Юмор и ирония"
                  min={0}
                  max={100}
                  value={draft.brief.quality.humorLevel}
                  valueLabel={scaleLabel(draft.brief.quality.humorLevel, ["сухо", "лёгкая ирония", "юмор", "мемы и сленг", "сарказм"])}
                  startLabel="без юмора"
                  endLabel="сарказм"
                  onChange={(value) => setQualityPatch({ humorLevel: value, humor: value <= 5 ? "none" : value < 60 ? "light" : "free" })}
                />
                <RangeSetting
                  id="channel-opinion"
                  label="Острота мнения"
                  min={0}
                  max={100}
                  value={draft.brief.quality.opinionSharpness}
                  valueLabel={scaleLabel(draft.brief.quality.opinionSharpness, ["нейтрально", "аккуратно", "позиция", "полемика", "против mainstream"])}
                  startLabel="нейтрально"
                  endLabel="жёстко"
                  onChange={(value) => setQuality("opinionSharpness", value)}
                />
                <RangeSetting
                  id="channel-profanity"
                  label="Мат и грубая лексика"
                  min={0}
                  max={100}
                  value={draft.brief.quality.profanityLevel}
                  valueLabel={scaleLabel(draft.brief.quality.profanityLevel, ["полный запрет", "просторечия", "мат со звёздочками", "прямой мат допустим", "прямой мат обязателен"])}
                  startLabel="без мата"
                  endLabel="мат обязателен"
                  onChange={(value) => setQualityPatch({ profanityLevel: value, profanity: value === 0 ? "forbid" : "allow" })}
                />
                <Field label="Роль / персона автора" htmlFor="channel-persona">
                  <Input id="channel-persona" value={draft.brief.quality.persona} onChange={(event) => setQuality("persona", event.target.value)} placeholder="Например: практикующий юрист-наставник" />
                </Field>
                <Field label="Точное описание тона" htmlFor="channel-tone">
                  <Input id="channel-tone" value={draft.brief.quality.tone} onChange={(event) => setQuality("tone", event.target.value)} placeholder="Спокойный, уверенный, с надеждой" />
                </Field>
              </div>
            </SettingsGroup>

            <SettingsGroup
              title="Язык и лексика"
              description="Насколько просто, оригинально и профессионально звучит текст."
              icon={<FileText className="h-4 w-4" aria-hidden />}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <RangeSetting
                  id="channel-language-complexity"
                  label="Сложность языка"
                  min={0}
                  max={100}
                  value={draft.brief.quality.languageComplexity}
                  valueLabel={scaleLabel(draft.brief.quality.languageComplexity, ["очень просто", "просто", "средне", "профессионально", "экспертно"])}
                  startLabel="для новичка"
                  endLabel="для профи"
                  onChange={(value) => setQuality("languageComplexity", value)}
                />
                <RangeSetting
                  id="channel-originality"
                  label="Уникальность / анти-клише"
                  min={0}
                  max={100}
                  value={draft.brief.quality.originality}
                  valueLabel={`${draft.brief.quality.originality}/100`}
                  startLabel="привычно"
                  endLabel="максимально оригинально"
                  onChange={(value) => setQuality("originality", value)}
                />
              </div>
              <Field label="Правила языка" htmlFor="channel-language-rules" hint="Термины, лексика и способ объяснять сложное.">
                <Textarea id="channel-language-rules" rows={3} value={draft.brief.quality.languageLevel} onChange={(event) => setQuality("languageLevel", event.target.value)} placeholder="Простой литературный русский; каждый термин сразу объяснять" />
              </Field>
            </SettingsGroup>

            <SettingsGroup
              title="Структура и формат"
              description="Длина, ритм, хук, списки, цитаты и мини-истории."
              icon={<SlidersHorizontal className="h-4 w-4" aria-hidden />}
              defaultOpen
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <RangeSetting
                  id="channel-min-length"
                  label="Минимальная длина"
                  min={300}
                  max={Math.max(300, draft.brief.quality.maxChars - 100)}
                  step={100}
                  value={draft.brief.quality.minChars}
                  valueLabel={`${draft.brief.quality.minChars} знаков`}
                  startLabel="короче"
                  endLabel="подробнее"
                  onChange={(value) => setQuality("minChars", value)}
                />
                <RangeSetting
                  id="channel-max-length"
                  label="Максимальная длина"
                  min={Math.min(3900, draft.brief.quality.minChars + 100)}
                  max={4000}
                  step={100}
                  value={draft.brief.quality.maxChars}
                  valueLabel={`${draft.brief.quality.maxChars} знаков`}
                  startLabel="компактно"
                  endLabel="лонгрид"
                  onChange={(value) => setQuality("maxChars", value)}
                />
                <RangeSetting
                  id="channel-format-style"
                  label="Основной формат подачи"
                  min={0}
                  max={5}
                  value={draft.brief.quality.formatStyle}
                  valueLabel={FORMAT_LABELS[draft.brief.quality.formatStyle]}
                  startLabel="история"
                  endLabel="мнение"
                  onChange={(value) => setQuality("formatStyle", value)}
                />
                <RangeSetting
                  id="channel-sentence-rhythm"
                  label="Ритм фраз"
                  min={0}
                  max={100}
                  value={draft.brief.quality.sentenceRhythm}
                  valueLabel={scaleLabel(draft.brief.quality.sentenceRhythm, ["рублено", "коротко", "смешанно", "развёрнуто", "длинные фразы"])}
                  startLabel="короткие"
                  endLabel="развёрнутые"
                  onChange={(value) => setQuality("sentenceRhythm", value)}
                />
                <RangeSetting
                  id="channel-paragraphs"
                  label="Плотность абзацев"
                  min={1}
                  max={6}
                  value={draft.brief.quality.maxParagraphSentences}
                  valueLabel={`до ${draft.brief.quality.maxParagraphSentences} предложений`}
                  startLabel="воздушно"
                  endLabel="плотно"
                  onChange={(value) => setQuality("maxParagraphSentences", value)}
                />
                <RangeSetting
                  id="channel-lists"
                  label="Списки и чек-листы"
                  min={0}
                  max={100}
                  value={draft.brief.quality.listIntensity}
                  valueLabel={`${draft.brief.quality.listIntensity}/100`}
                  startLabel="без списков"
                  endLabel="часто"
                  onChange={(value) => setQualityPatch({ listIntensity: value, listPolicy: value < 15 ? "avoid" : value > 75 ? "required" : "when_useful" })}
                />
                <RangeSetting
                  id="channel-bold"
                  label="Жирные акценты"
                  min={0}
                  max={100}
                  value={draft.brief.quality.boldIntensity}
                  valueLabel={`${draft.brief.quality.boldIntensity}/100`}
                  startLabel="без выделений"
                  endLabel="активно"
                  onChange={(value) => setQualityPatch({ boldIntensity: value, boldPolicy: value < 10 ? "none" : value > 75 ? "required" : "restrained" })}
                />
                <RangeSetting
                  id="channel-hook-style"
                  label="Тип первой строки"
                  min={0}
                  max={4}
                  value={draft.brief.quality.hookStyle}
                  valueLabel={HOOK_LABELS[draft.brief.quality.hookStyle]}
                  startLabel="вопрос"
                  endLabel="цитата"
                  onChange={(value) => setQuality("hookStyle", value)}
                />
                <RangeSetting
                  id="channel-hook-intensity"
                  label="Сила крючка"
                  min={0}
                  max={100}
                  value={draft.brief.quality.hookIntensity}
                  valueLabel={`${draft.brief.quality.hookIntensity}/100`}
                  startLabel="спокойно"
                  endLabel="цепко"
                  onChange={(value) => setQualityPatch({ hookIntensity: value, hookRequired: value > 0 })}
                />
                <RangeSetting
                  id="channel-hook-length"
                  label="Длина первой строки"
                  min={30}
                  max={160}
                  step={5}
                  value={draft.brief.quality.hookMaxChars}
                  valueLabel={`до ${draft.brief.quality.hookMaxChars} знаков`}
                  startLabel="коротко"
                  endLabel="развёрнуто"
                  onChange={(value) => setQuality("hookMaxChars", value)}
                />
                <RangeSetting
                  id="channel-quotes"
                  label="Прямая речь и цитаты"
                  min={0}
                  max={100}
                  value={draft.brief.quality.quoteIntensity}
                  valueLabel={`${draft.brief.quality.quoteIntensity}/100`}
                  startLabel="без цитат"
                  endLabel="много реплик"
                  onChange={(value) => setQualityPatch({ quoteIntensity: value, directSpeech: value < 10 ? "avoid" : "allowed" })}
                />
                <RangeSetting
                  id="channel-scenes"
                  label="Сценки и мини-истории"
                  min={0}
                  max={100}
                  value={draft.brief.quality.sceneIntensity}
                  valueLabel={`${draft.brief.quality.sceneIntensity}/100`}
                  startLabel="без сценок"
                  endLabel="сторителлинг"
                  onChange={(value) => setQuality("sceneIntensity", value)}
                />
                <RangeSetting
                  id="channel-reader-dialogue"
                  label="Диалог с читателем"
                  min={0}
                  max={100}
                  value={draft.brief.quality.readerDialogue}
                  valueLabel={`${draft.brief.quality.readerDialogue}/100`}
                  startLabel="без вопросов"
                  endLabel="активный диалог"
                  onChange={(value) => setQuality("readerDialogue", value)}
                />
              </div>
              <Toggle
                id="channel-conclusion"
                checked={draft.brief.quality.requireConclusion}
                onChange={(value) => setQuality("requireConclusion", value)}
                label="Завершать содержательным выводом"
                description="Не формальным итогом, а мыслью, которую читатель унесёт с собой."
              />
            </SettingsGroup>

            <SettingsGroup
              title="Контент и смысл"
              description="Баланс фактов, личного опыта, актуальности и уровень читателя."
              icon={<Sparkles className="h-4 w-4" aria-hidden />}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <RangeSetting
                  id="channel-facts-share"
                  label="Опора на факты"
                  min={0}
                  max={100}
                  value={draft.brief.quality.factShare}
                  valueLabel={`${draft.brief.quality.factShare}% фактов`}
                  startLabel="личное мнение"
                  endLabel="цифры и источники"
                  onChange={(value) => setQuality("factShare", value)}
                />
                <RangeSetting
                  id="channel-citations"
                  label="Доля подтверждённых фактов"
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round(draft.brief.quality.minCitationShare * 100)}
                  valueLabel={`${Math.round(draft.brief.quality.minCitationShare * 100)}% со ссылками`}
                  startLabel="мягко"
                  endLabel="только с источником"
                  onChange={(value) => setQuality("minCitationShare", value / 100)}
                />
                <RangeSetting
                  id="channel-personal-stories"
                  label="Личные истории и опыт"
                  min={0}
                  max={100}
                  value={draft.brief.quality.personalStoryShare}
                  valueLabel={`${draft.brief.quality.personalStoryShare}% текста`}
                  startLabel="обезличенно"
                  endLabel="много опыта"
                  onChange={(value) => setQuality("personalStoryShare", value)}
                />
                <RangeSetting
                  id="channel-trends"
                  label="Привязка к актуальному"
                  min={0}
                  max={100}
                  value={draft.brief.quality.trendFocus}
                  valueLabel={scaleLabel(draft.brief.quality.trendFocus, ["вечнозелёный", "редкие поводы", "баланс", "тренды", "максимально актуально"])}
                  startLabel="вечнозелёное"
                  endLabel="инфоповоды"
                  onChange={(value) => setQuality("trendFocus", value)}
                />
                <RangeSetting
                  id="channel-audience-level"
                  label="Уровень аудитории в теме"
                  min={0}
                  max={100}
                  value={draft.brief.quality.audienceExpertise}
                  valueLabel={scaleLabel(draft.brief.quality.audienceExpertise, ["новичок", "начинающий", "в теме", "продвинутый", "профессионал"])}
                  startLabel="новичок"
                  endLabel="профи"
                  onChange={(value) => setQuality("audienceExpertise", value)}
                />
                <RangeSetting
                  id="channel-post-goal"
                  label="Главная цель поста"
                  min={0}
                  max={4}
                  value={draft.brief.quality.postGoal}
                  valueLabel={GOAL_LABELS[draft.brief.quality.postGoal]}
                  startLabel="охват"
                  endLabel="удержание"
                  onChange={(value) => setQuality("postGoal", value)}
                />
              </div>
              <Segments
                label="Правило для фактов и источников"
                value={draft.brief.quality.factsPolicy}
                onChange={(value) => setQuality("factsPolicy", value)}
                options={[
                  { value: "source_required", label: "Только с источником" },
                  { value: "no_unverified_specifics", label: "Без выдуманных деталей" },
                  { value: "open", label: "Свободнее" },
                ]}
              />
            </SettingsGroup>

            <SettingsGroup
              title="Вовлечение и продажи"
              description="Насколько активно продавать, звать к действию и поддерживать диалог."
              icon={<SlidersHorizontal className="h-4 w-4" aria-hidden />}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <RangeSetting
                  id="channel-sales"
                  label="Продающесть / нативность"
                  min={0}
                  max={100}
                  step={5}
                  value={draft.brief.quality.salesMaxPercent}
                  valueLabel={`до ${draft.brief.quality.salesMaxPercent}% текста`}
                  startLabel="без продаж"
                  endLabel="прямой оффер"
                  onChange={(value) => setQuality("salesMaxPercent", value)}
                />
                <RangeSetting
                  id="channel-cta-intensity"
                  label="Интенсивность призыва"
                  min={0}
                  max={100}
                  value={draft.brief.quality.ctaIntensity}
                  valueLabel={scaleLabel(draft.brief.quality.ctaIntensity, ["без призыва", "очень мягко", "мягко", "уверенно", "жёсткий призыв"])}
                  startLabel="без давления"
                  endLabel="прямо"
                  onChange={(value) => setQualityPatch({ ctaIntensity: value, ctaStyle: value === 0 ? "none" : value < 70 ? "soft" : "direct" })}
                />
                <RangeSetting
                  id="channel-cta-frequency"
                  label="Частота призыва"
                  min={1}
                  max={12}
                  value={draft.brief.quality.ctaEveryPosts}
                  valueLabel={`каждый ${draft.brief.quality.ctaEveryPosts}-й пост`}
                  startLabel="часто"
                  endLabel="редко"
                  onChange={(value) => setQuality("ctaEveryPosts", value)}
                />
                <RangeSetting
                  id="channel-interactivity"
                  label="Вовлечение / интерактив"
                  min={0}
                  max={100}
                  value={draft.brief.quality.interactivity}
                  valueLabel={`${draft.brief.quality.interactivity}/100`}
                  startLabel="монолог"
                  endLabel="опросы и вопросы"
                  onChange={(value) => setQuality("interactivity", value)}
                />
              </div>
            </SettingsGroup>

            <SettingsGroup
              title="Оформление и визуал"
              description="Эмодзи, хэштеги, ссылки, упоминания и задание для картинки."
              icon={<FileText className="h-4 w-4" aria-hidden />}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <RangeSetting
                  id="channel-emojis"
                  label="Максимум эмодзи"
                  min={0}
                  max={20}
                  value={draft.brief.quality.maxEmojis}
                  valueLabel={`${draft.brief.quality.maxEmojis} в посте`}
                  startLabel="без эмодзи"
                  endLabel="много"
                  onChange={(value) => setQualityPatch({ maxEmojis: value, emojiPolicy: value === 0 ? "none" : value <= 3 ? "restrained" : "active" })}
                />
                <RangeSetting
                  id="channel-hashtags"
                  label="Количество хэштегов"
                  min={0}
                  max={10}
                  value={draft.brief.quality.maxHashtags}
                  valueLabel={`${draft.brief.quality.maxHashtags} в посте`}
                  startLabel="без хэштегов"
                  endLabel="10 штук"
                  onChange={(value) => setQualityPatch({ maxHashtags: value, hashtagsPolicy: value === 0 ? "none" : "restrained" })}
                />
                <RangeSetting
                  id="channel-source-links"
                  label="Ссылки на источники"
                  min={0}
                  max={100}
                  value={draft.brief.quality.sourceLinkIntensity}
                  valueLabel={`${draft.brief.quality.sourceLinkIntensity}/100`}
                  startLabel="редко"
                  endLabel="к каждому факту"
                  onChange={(value) => setQuality("sourceLinkIntensity", value)}
                />
                <RangeSetting
                  id="channel-mentions"
                  label="@Упоминания и прошлые посты"
                  min={0}
                  max={100}
                  value={draft.brief.quality.mentionIntensity}
                  valueLabel={`${draft.brief.quality.mentionIntensity}/100`}
                  startLabel="не использовать"
                  endLabel="активно связывать"
                  onChange={(value) => setQuality("mentionIntensity", value)}
                />
                <RangeSetting
                  id="channel-visuals"
                  label="Частота визуального сопровождения"
                  min={0}
                  max={100}
                  value={draft.brief.quality.visualIntensity}
                  valueLabel={`${draft.brief.quality.visualIntensity}/100`}
                  startLabel="текстом"
                  endLabel="визуал к каждому посту"
                  onChange={(value) => setQuality("visualIntensity", value)}
                />
                <RangeSetting
                  id="channel-visual-detail"
                  label="Детализация промпта для картинки"
                  min={0}
                  max={100}
                  value={draft.brief.quality.visualDetail}
                  valueLabel={`${draft.brief.quality.visualDetail}/100`}
                  startLabel="коротко"
                  endLabel="подробное ТЗ"
                  onChange={(value) => setQuality("visualDetail", value)}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Разрешённые эмодзи" htmlFor="channel-allowed-emoji">
                  <Input id="channel-allowed-emoji" value={draft.brief.quality.allowedEmoji} onChange={(event) => setQuality("allowedEmoji", event.target.value)} placeholder="✅ ❌ ⚖️ 📌" />
                </Field>
                <Field label="Фирменные хэштеги" htmlFor="channel-branded-hashtags">
                  <Input id="channel-branded-hashtags" value={draft.brief.quality.brandedHashtags} onChange={(event) => setQuality("brandedHashtags", event.target.value)} placeholder="#бренд #рубрика" />
                </Field>
                <Field label="Правила ссылок и упоминаний" htmlFor="channel-link-rules">
                  <Textarea id="channel-link-rules" rows={3} value={draft.brief.quality.linkRules} onChange={(event) => setQuality("linkRules", event.target.value)} placeholder="Ссылаться только на официальные источники" />
                </Field>
                <Field label="Стиль визуала" htmlFor="channel-visual-direction">
                  <Textarea id="channel-visual-direction" rows={3} value={draft.brief.quality.visualDirection} onChange={(event) => setQuality("visualDirection", event.target.value)} placeholder="Лаконичная инфографика, тёмный фон, один акцентный цвет" />
                </Field>
              </div>
            </SettingsGroup>

            <SettingsGroup
              title="Автопилот"
              description="Частота плана и уровень контроля перед публикацией."
              icon={<Sparkles className="h-4 w-4" aria-hidden />}
              kind="autopilot"
              defaultOpen
            >
              <Toggle
                id="channel-autopilot-enabled"
                checked={draft.settings.enabled}
                onChange={(value) => setAutopilot("enabled", value)}
                label="Включить автопилот для этого канала"
                description="Аврора будет собирать план недели по сохранённому профилю."
              />
              <div className="rounded-sm border border-line bg-surface/80 p-4">
                <p className="text-[13px] font-bold text-text">Ритм публикаций</p>
                <p className="mt-1 text-[13px] leading-relaxed text-text-3">
                  Один пост в день — 7 готовых публикаций на каждую неделю плана.
                </p>
              </div>
              <div className="rounded-sm border border-brand/20 bg-info-soft p-4">
                <p className="text-[13px] font-bold text-text">Публикация только после проверки</p>
                <p className="mt-1 text-[13px] leading-relaxed text-text-3">
                  Аврора подготовит весь план и предложит расписание. В календарь попадёт только точная версия, которую ты просмотрел и одобрил.
                </p>
              </div>
            </SettingsGroup>

            <SettingsGroup
              title="Качество и ограничения"
              description="Точные правила, которые Аврора не имеет права нарушать."
              icon={<ShieldCheck className="h-4 w-4" aria-hidden />}
            >
              <div>
                <p className="mb-2 text-[13px] font-semibold text-text-2">Готовая основа</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {Object.values(QUALITY_PRESETS).map((preset) => {
                    const active = draft.brief.quality.preset === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setDraft((current) => current
                          ? {
                              ...current,
                              brief: {
                                ...current.brief,
                                source: "manual",
                                quality: {
                                  ...presetQuality(preset.id),
                                  styleExamples: current.brief.quality.styleExamples,
                                },
                              },
                            }
                          : current)}
                        className={cn(
                          "rounded-sm border p-3 text-left",
                          active ? "border-brand bg-info-soft" : "border-line bg-surface hover:border-brand/35",
                        )}
                      >
                        <span className="text-[13px] font-bold text-text">{preset.label}</span>
                        <span className="mt-1 block text-[11px] leading-relaxed text-text-3">{preset.description}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <RangeSetting
                  id="channel-quality"
                  label="Порог качества"
                  min={70}
                  max={100}
                  step={5}
                  value={draft.brief.quality.qualityThreshold}
                  valueLabel={`${draft.brief.quality.qualityThreshold}/100`}
                  startLabel="мягче"
                  endLabel="строже"
                  onChange={(value) => setQuality("qualityThreshold", value)}
                />
                <RangeSetting
                  id="channel-retries"
                  label="Попытки автоматической редактуры"
                  min={0}
                  max={3}
                  value={draft.brief.quality.retryLimit}
                  valueLabel={`${draft.brief.quality.retryLimit} ${plural(draft.brief.quality.retryLimit, "попытка", "попытки", "попыток")}`}
                  startLabel="не переписывать"
                  endLabel="до идеала"
                  onChange={(value) => setQuality("retryLimit", value)}
                />
              </div>
              <Toggle
                id="channel-competitor-topics"
                checked={draft.brief.quality.competitorTopics}
                onChange={(value) => setQuality("competitorTopics", value)}
                label="Разрешить темы конкурентов"
                description="Выключено по умолчанию: случайный залёт не должен увести канал в сторону."
              />
              <Field label="Стоп-темы" hint="Аврора не будет писать об этом никогда.">
                <Textarea rows={3} value={draft.brief.taboo} onChange={(event) => setBrief("taboo", event.target.value)} placeholder="Политика, чужие бренды, неподтверждённые обещания…" />
              </Field>
              <Field label="Запрещённые темы, бренды и конкуренты" hint="Один пункт на строку. Совпадение блокирует выпуск.">
                <Textarea
                  rows={4}
                  value={draft.brief.quality.forbiddenTopics.join("\n")}
                  onChange={(event) => setQuality(
                    "forbiddenTopics",
                    [...new Set(event.target.value.split("\n").map((item) => item.trim()).filter(Boolean))],
                  )}
                  placeholder={"политика\nназвание конкурента\nсерые схемы"}
                />
              </Field>
              <Field label="Запрещённые фразы" hint="Одна фраза на строку. Совпадение блокирует выпуск.">
                <Textarea
                  rows={5}
                  value={draft.brief.quality.forbiddenPhrases.join("\n")}
                  onChange={(event) => setQuality(
                    "forbiddenPhrases",
                    [...new Set(event.target.value.split("\n").map((item) => item.trim()).filter(Boolean))],
                  )}
                  placeholder={"гарантируем результат\nуспейте прямо сейчас"}
                />
              </Field>
              <Toggle
                id="channel-disclaimer-required"
                checked={draft.brief.quality.disclaimerRequired}
                onChange={(value) => setQuality("disclaimerRequired", value)}
                label="Обязательный дисклеймер"
                description="Аврора поставит его дословно последней строкой каждого поста."
              />
              {draft.brief.quality.disclaimerRequired && (
                <Field label="Текст дисклеймера" htmlFor="channel-disclaimer">
                  <Textarea id="channel-disclaimer" rows={3} value={draft.brief.quality.disclaimerText} onChange={(event) => setQuality("disclaimerText", event.target.value)} placeholder="Материал носит информационный характер…" />
                </Field>
              )}
            </SettingsGroup>

            <div className={cn(
              "flex flex-col gap-3 bg-surface/95 px-5 py-4 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between sm:px-6",
              dirty && "sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-20 border-t border-brand/20 shadow-float lg:bottom-0",
            )}>
              <div>
                <p className="text-[13px] font-bold text-text">
                  {dirty ? "Есть несохранённые изменения" : "Все изменения сохранены"}
                </p>
                <p className="mt-0.5 text-[11px] text-text-3">
                  {dirty ? "Они ещё не влияют на генерации и автопилот." : "Аврора использует этот профиль в следующих публикациях."}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {dirty && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                    onClick={() => {
                      setDraft(saved);
                      setStyleText(saved.brief.quality.styleExamples.join("\n---\n"));
                      setAnalysis(null);
                    }}
                  >
                    <RotateCcw className="h-4 w-4" aria-hidden />
                    Отменить
                  </Button>
                )}
                <Button variant="brand" size="sm" loading={saving} disabled={!dirty || saving} onClick={() => void save()}>
                  <Save className="h-4 w-4" aria-hidden />
                  {view === "autopilot" ? "Сохранить автопилот" : "Сохранить контент и стиль"}
                </Button>
              </div>
            </div>
          </Card>
          </div>
        </>
      )}

      <ConfirmDialog
        open={pendingChannel != null}
        title="Переключить канал без сохранения?"
        description="Изменения текущего профиля пропадут. Сохранённые настройки канала останутся без изменений."
        confirmLabel="Переключить"
        onCancel={() => setPendingChannel(null)}
        onConfirm={() => {
          if (pendingChannel != null) setPicked(pendingChannel);
          setPendingChannel(null);
        }}
      />
      <ConfirmDialog
        open={copyTarget != null}
        title="Заменить настройки другого канала?"
        description="Скопируем сохранённый профиль. Автопилот в целевом канале останется выключенным, пока ты не проверишь настройки."
        confirmLabel="Скопировать профиль"
        onCancel={() => setCopyTarget(null)}
        onConfirm={() => void copyConfiguration()}
      />
    </div>
    </ChannelSettingsViewContext.Provider>
  );
}
