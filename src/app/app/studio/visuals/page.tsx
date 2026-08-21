"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  Clapperboard,
  Download,
  Layers3,
  Loader2,
  Plus,
  Save,
  Trash2,
  Upload,
  WandSparkles,
} from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { Button } from "@/components/ui/button";
import { Badge, Card, Checkbox, Field, Input, Textarea } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

import {
  LEGAL_VISUAL_FONT_OPTIONS,
  legalVisualFontFamily,
  mediaAssetToVisualReference,
  toggleAllowedVisualFont,
  type LegalVisualAssetReference,
  type LegalVisualFont,
  type LegalVisualMediaAsset,
} from "./legal-visual-ui";

type Format = "1:1" | "4:5" | "9:16";
type Template = typeof TEMPLATES[number]["key"];
type Brand = {
  name: string;
  logo: AssetReference | null;
  colors: { background: string; surface: string; text: string; mutedText: string; accent: string; critical: string };
  allowedFonts: LegalVisualFont[];
  font: LegalVisualFont;
  signature: string;
};
type AssetReference = LegalVisualAssetReference;
type VisualCard = {
  id: string;
  order: number;
  role: "hook" | "context" | "audience" | "actions" | "deadline" | "caveat" | "cta";
  template: Template;
  eyebrow: string;
  title: string;
  theses: string[];
  emphasis: string;
  image: AssetReference | null;
  cta: { label: string; url: string | null } | null;
  sourceNote: string;
};
type VisualCardRole = VisualCard["role"];
const VISUAL_CARD_ROLE_ORDER: readonly VisualCardRole[] = [
  "hook", "context", "audience", "actions", "deadline", "caveat", "cta",
];
type VisualConfig = {
  schemaVersion: 1;
  id: string;
  projectId: string;
  revision: number;
  name: string;
  format: Format;
  brand: Brand;
  cards: VisualCard[];
};
type Design = {
  id: number;
  name: string;
  format: Format;
  status: string;
  revision: number;
  renderedRevision: number | null;
  config: VisualConfig;
  updatedAt: string;
};
type MediaAsset = LegalVisualMediaAsset & {
  id: number;
  fileName: string;
  mimeType: AssetReference["mimeType"];
  bytes: number;
  sha256: string;
  origin: string;
  width: number | null;
  height: number | null;
  url: string;
};
type RenderCard = { id: string; order: number; assetId: number; url: string; width: number; height: number };
type RenderResult = { id: number; status: string; errorMessage: string | null; cards: RenderCard[] };
type VideoScene = {
  id: string;
  order: number;
  role: "hook" | "body" | "cta";
  durationSeconds: number;
  voiceOver: string;
  onScreenText: string;
  visualDirection: string;
  sourceClaimIds: string[];
};
type VideoScriptRecord = {
  id: number;
  title: string;
  durationSeconds: 30 | 45 | 60;
  revision: number;
  script: { scenes: Array<VideoScene & { productionTiming?: unknown }> };
  updatedAt: string;
};
type VisualLayoutIssue = {
  id?: string;
  code?: string;
  severity?: "error" | "warning";
  cardId?: string | null;
  message?: string;
  field?: string;
};
type ApiError = { error?: string; requestId?: string; issues?: VisualLayoutIssue[] };

const TEMPLATES = [
  { key: "what_changed", label: "Что изменилось" },
  { key: "three_actions", label: "3 действия" },
  { key: "deadlines", label: "Сроки" },
  { key: "business_mistake", label: "Ошибка бизнеса" },
  { key: "court_holding", label: "Вывод суда" },
  { key: "myth_fact", label: "Миф / факт" },
  { key: "checklist", label: "Чек-лист" },
  { key: "question_answer", label: "Вопрос / ответ" },
  { key: "key_number", label: "Цифра" },
  { key: "announcement", label: "Анонс" },
  { key: "case_study", label: "Разбор ситуации" },
] as const;

const SELECT_CLASS = "h-12 w-full rounded-xs border border-line bg-surface px-3 text-base text-text focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 sm:text-[15px]";

function carouselCardCountLabel(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${count} карточек`;
  if (mod10 === 1) return `${count} карточка`;
  if (mod10 >= 2 && mod10 <= 4) return `${count} карточки`;
  return `${count} карточек`;
}

function addSemanticCarouselCard(cards: VisualCard[]): { cards: VisualCard[]; added: VisualCard } | null {
  if (cards.length >= 7) return null;
  const ctaIndex = cards.findIndex((card) => card.role === "cta");
  if (ctaIndex < 1) return null;
  const used = new Set(cards.map((card) => card.role));
  const previousRole = cards[ctaIndex - 1]?.role;
  const previousRank = previousRole ? VISUAL_CARD_ROLE_ORDER.indexOf(previousRole) : -1;
  const nextRole = VISUAL_CARD_ROLE_ORDER
    .slice(previousRank + 1, -1)
    .find((role) => !used.has(role));
  if (!nextRole) return null;
  const added: VisualCard = {
    id: `card-${crypto.randomUUID()}`,
    order: ctaIndex + 1,
    role: nextRole,
    template: nextRole === "deadline" ? "deadlines" : nextRole === "actions" ? "three_actions" : "question_answer",
    eyebrow: "",
    title: "Новая карточка",
    theses: ["Добавьте тезис"],
    emphasis: "",
    image: null,
    cta: null,
    sourceNote: "",
  };
  const nextCards = [...cards.slice(0, ctaIndex), added, ...cards.slice(ctaIndex)]
    .map((card, index) => ({ ...card, order: index + 1 }));
  return { cards: nextCards, added };
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({})) as T & ApiError;
  if (!response.ok) throw Object.assign(new Error(payload.error || "request_failed"), payload);
  return payload;
}

function requestKey(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}

function reorder(cards: VisualCard[], from: number, to: number) {
  if (to < 0 || to >= cards.length || from === to) return cards;
  const next = [...cards];
  const [card] = next.splice(from, 1);
  next.splice(to, 0, card);
  return next.map((item, index) => ({ ...item, order: index + 1 }));
}

function errorLabel(error: unknown) {
  const code = error instanceof Error ? error.message : "request_failed";
  const labels: Record<string, string> = {
    access_denied: "В этом проекте не хватает прав для действия.",
    invalid_config: "Проверьте поля карточек: некоторые значения не подходят макету.",
    invalid_brand_kit: "Проверьте фирменный стиль: выберите хотя бы один шрифт и корректные цвета.",
    unsafe_layout: "Текст не помещается в безопасную область. Сократите отмеченные поля.",
    version_conflict: "Данные изменились в другой вкладке. Обновите страницу перед сохранением.",
    asset_not_found: "Выбранное изображение больше недоступно. Выберите другой файл.",
    invalid_image: "Выберите изображение PNG, JPEG или WebP размером до 10 МБ.",
    payload_too_large: "Изображение больше 10 МБ. Выберите файл меньшего размера.",
    upload_busy: "Сейчас обрабатываются другие изображения. Подождите несколько секунд и повторите загрузку.",
    bad_multipart: "Не удалось прочитать файл. Выберите изображение ещё раз.",
    invalid_script: "Сценарий добавляет неподтверждённый факт или нарушает хронометраж.",
    empty_draft: "В исходном черновике нет текста для сценария.",
    draft_not_found: "Черновик не найден в выбранном проекте.",
    approval_required: "Сначала отправьте эту версию поста на согласование и получите одобрение.",
  };
  return labels[code] ?? "Не удалось выполнить действие. Проверьте соединение и попробуйте ещё раз.";
}

function layoutIssuesFromError(error: unknown): VisualLayoutIssue[] {
  if (!error || typeof error !== "object" || !("issues" in error) || !Array.isArray(error.issues)) return [];
  const issues = error.issues.filter((issue): issue is VisualLayoutIssue => Boolean(issue && typeof issue === "object"));
  return issues.filter((issue) => issue.field !== "layout" || !issues.some((other) => (
    other.cardId === issue.cardId && other.field !== "layout" && other.severity === "error"
  )));
}

function visualIssueFieldLabel(field?: string): string {
  const labels: Record<string, string> = {
    title: "Заголовок",
    theses: "Тезисы",
    emphasis: "Акцент",
    "cta.label": "Призыв к действию",
    "brand.signature": "Подпись",
    "brand.colors.text": "Основной текст",
    "brand.colors.surface": "Текст на карточках",
    layout: "Расположение",
  };
  return labels[field ?? ""] ?? "Содержимое";
}

function VisualPreview({ config, activeCardId }: { config: VisualConfig; activeCardId: string }) {
  const card = config.cards.find((item) => item.id === activeCardId) ?? config.cards[0];
  if (!card) return null;
  const ratio = config.format === "1:1" ? "aspect-square" : config.format === "4:5" ? "aspect-[4/5]" : "aspect-[9/16]";
  return (
    <div
      className={cn("relative mx-auto w-full max-w-[420px] overflow-hidden rounded-md border border-line shadow-lg", ratio)}
      style={{
        backgroundColor: config.brand.colors.background,
        color: config.brand.colors.text,
        fontFamily: legalVisualFontFamily(config.brand.font),
      }}
      aria-label={`Предпросмотр карточки ${card.order}: ${card.title}`}
    >
      <div className="absolute inset-[7%] flex flex-col">
        <p className="text-[clamp(10px,2vw,14px)] font-bold tracking-[0.12em] uppercase" style={{ color: config.brand.colors.accent }}>
          {card.eyebrow || TEMPLATES.find((item) => item.key === card.template)?.label}
        </p>
        <h3 className="mt-[5%] text-[clamp(20px,5vw,40px)] leading-[1.05] font-extrabold tracking-tight">
          {card.title || "Добавьте заголовок"}
        </h3>
        {card.image && (
          // eslint-disable-next-line @next/next/no-img-element -- authenticated project media cannot use the image optimizer
          <img src={`/api/media/assets/${card.image.assetId}`} alt={card.image.alt} className="mt-[5%] min-h-0 flex-1 rounded-sm object-cover" />
        )}
        <ul className="mt-[6%] space-y-[3%] text-[clamp(11px,2.4vw,18px)] leading-snug">
          {card.theses.map((thesis, index) => <li key={`${card.id}-thesis-${index}`} className="flex gap-2"><span style={{ color: config.brand.colors.accent }}>•</span><span>{thesis}</span></li>)}
        </ul>
        {card.cta && <p className="mt-auto rounded-full px-4 py-2 text-center text-[clamp(10px,2vw,15px)] font-bold" style={{ backgroundColor: config.brand.colors.accent, color: config.brand.colors.background }}>{card.cta.label}</p>}
        <div className={cn("flex min-w-0 items-center gap-2 pt-[4%]", card.cta ? "" : "mt-auto")}>
          {config.brand.logo && (
            // eslint-disable-next-line @next/next/no-img-element -- authenticated project media cannot use the image optimizer
            <img
              src={`/api/media/assets/${config.brand.logo.assetId}`}
              alt={config.brand.logo.alt}
              className="h-[clamp(24px,6vw,44px)] w-[clamp(24px,6vw,44px)] shrink-0 rounded-xs object-contain outline outline-1 outline-white/10"
            />
          )}
          <p className="min-w-0 text-[clamp(8px,1.6vw,11px)] leading-snug" style={{ color: config.brand.colors.mutedText }}>{config.brand.signature}</p>
        </div>
      </div>
    </div>
  );
}

function EmptyIntro({ draftId, onCreated }: { draftId: number | null; onCreated: (design: Design) => void }) {
  const [name, setName] = useState("Юридическая карусель");
  const [format, setFormat] = useState<Format>("4:5");
  const [template, setTemplate] = useState<Template>("what_changed");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Card className="mx-auto max-w-2xl p-6 md:p-8">
      <div className="flex h-12 w-12 items-center justify-center rounded-sm bg-info-soft text-info-text"><Layers3 aria-hidden /></div>
      <h2 className="mt-5 text-2xl font-bold tracking-tight text-text">Новая карусель</h2>
      <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-text-3">Выберите основу — Аврора подготовит три редактируемые карточки. Перед экспортом проверит безопасную область и контраст.</p>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Field label="Название" htmlFor="visual-name"><Input id="visual-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={160} /></Field>
        <Field label="Формат" htmlFor="visual-format"><select id="visual-format" className={SELECT_CLASS} value={format} onChange={(event) => setFormat(event.target.value as Format)}><option value="1:1">Квадрат 1:1</option><option value="4:5">Лента 4:5</option><option value="9:16">Истории 9:16</option></select></Field>
        <Field label="Шаблон первой карточки" htmlFor="visual-template"><select id="visual-template" className={SELECT_CLASS} value={template} onChange={(event) => setTemplate(event.target.value as Template)}>{TEMPLATES.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></Field>
        <div className="flex items-end"><p className="pb-3 text-[13px] leading-relaxed text-text-3">{draftId ? `Основа — черновик № ${draftId}` : "Можно начать без черновика и заполнить всё вручную."}</p></div>
      </div>
      {error && <p role="alert" className="mt-4 text-[13px] font-medium text-danger-text">{error}</p>}
      <Button variant="brand" className="mt-6" loading={busy} onClick={async () => {
        setBusy(true); setError("");
        try {
          const result = await json<{ design: Design }>("/api/legal-visuals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestKey: requestKey("visual"), name, format, template, ...(draftId ? { sourceDraftId: draftId } : {}) }) });
          onCreated(result.design);
        } catch (nextError) { setError(errorLabel(nextError)); } finally { setBusy(false); }
      }}><WandSparkles className="h-4 w-4" aria-hidden />Создать карусель</Button>
    </Card>
  );
}

function VisualEditor({
  design,
  draftId,
  returnTo,
  assets,
  projectBrand,
  onDesign,
  onAssets,
}: {
  design: Design;
  draftId: number | null;
  returnTo: "calendar" | "studio" | "autopilot-month" | null;
  assets: MediaAsset[];
  projectBrand: Brand;
  onDesign: (design: Design) => void;
  onAssets: (assets: MediaAsset[]) => void;
}) {
  const router = useRouter();
  const [config, setConfig] = useState(design.config);
  const [activeCardId, setActiveCardId] = useState(design.config.cards[0]?.id ?? "");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"save" | "render" | "upload" | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [layoutIssues, setLayoutIssues] = useState<VisualLayoutIssue[]>([]);
  const [render, setRender] = useState<RenderResult | null>(null);
  const pollRef = useRef<number | null>(null);
  const activeIndex = Math.max(0, config.cards.findIndex((item) => item.id === activeCardId));
  const active = config.cards[activeIndex];
  const usesProjectBrand = JSON.stringify(config.brand) === JSON.stringify(projectBrand);

  useEffect(() => () => { if (pollRef.current) window.clearTimeout(pollRef.current); }, []);
  const change = useCallback((next: VisualConfig) => {
    setConfig(next);
    setDirty(true);
    setError("");
    setLayoutIssues([]);
  }, []);
  const changeCard = (patch: Partial<VisualCard>) => {
    change({ ...config, cards: config.cards.map((card) => card.id === active.id ? { ...card, ...patch } : card) });
  };
  const move = (delta: -1 | 1) => {
    const next = reorder(config.cards, activeIndex, activeIndex + delta);
    change({ ...config, cards: next });
    setStatus(`Карточка перемещена на позицию ${activeIndex + delta + 1}`);
  };

  async function save() {
    setBusy("save"); setError(""); setStatus("Сохраняем макет…");
    try {
      const result = await json<{ design: Design }>(`/api/legal-visuals/${design.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: design.revision, config }),
      });
      onDesign(result.design); setConfig(result.design.config); setDirty(false); setStatus("Макет сохранён");
      return result.design;
    } catch (nextError) { setError(errorLabel(nextError)); setStatus(""); return null; } finally { setBusy(null); }
  }

  async function poll(operationId: number, revision: number) {
    try {
      const result = await json<{ render: RenderResult }>(`/api/legal-visuals/${design.id}/renders/${operationId}`);
      setRender(result.render);
      if (["pending", "queued", "rendering", "retryable_failed"].includes(result.render.status)) {
        setStatus(result.render.status === "rendering" ? "Собираем карточки PNG…" : "Сборка ждёт свободный обработчик…");
        pollRef.current = window.setTimeout(() => void poll(operationId, revision), 1_000);
      } else if (result.render.status === "ready") {
        setStatus(`Готово: ${carouselCardCountLabel(result.render.cards.length)} сохранено в медиатеке`);
        setBusy(null);
      } else {
        setError(result.render.errorMessage || "Сборка не завершилась. Исправьте макет и попробуйте ещё раз."); setStatus(""); setBusy(null);
      }
    } catch (nextError) { setError(errorLabel(nextError)); setBusy(null); }
  }

  async function renderNow() {
    setBusy("render"); setError(""); setStatus("Проверяем макет…");
    const current = dirty ? await save() : design;
    if (!current) { setBusy(null); return; }
    setBusy("render");
    try {
      const result = await json<{ operationId: number }>(`/api/legal-visuals/${current.id}/renders`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: current.revision, idempotencyKey: requestKey(`render-${current.id}-r${current.revision}`) }),
      });
      setStatus("Сборка поставлена в очередь…");
      await poll(result.operationId, current.revision);
    } catch (nextError) {
      setLayoutIssues(layoutIssuesFromError(nextError));
      setError(errorLabel(nextError));
      setStatus("");
      setBusy(null);
    }
  }

  function focusIssue(issue: VisualLayoutIssue) {
    if (issue.cardId) setActiveCardId(issue.cardId);
    window.requestAnimationFrame(() => {
      const selector = issue.field === "title"
        ? "#card-title"
        : issue.field === "theses"
          ? '[aria-label="Тезис 1"]'
          : issue.field === "cta.label"
            ? "#card-cta"
            : issue.field === "brand.signature"
              ? "#brand-signature"
              : null;
      const element = selector ? document.querySelector<HTMLElement>(selector) : null;
      element?.focus();
      element?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  if (!active) return null;
  return (
    <div className="grid min-h-0 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.78fr)]">
      <section aria-labelledby="visual-editor-heading" className="min-w-0 space-y-5">
        <Card className="p-5 md:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div><div className="flex flex-wrap items-center gap-2"><Badge tone="brand">Карусель</Badge><Badge>{carouselCardCountLabel(config.cards.length)}</Badge><Badge>{config.format}</Badge></div><h2 id="visual-editor-heading" className="mt-3 text-2xl font-bold tracking-tight text-text">{config.name}</h2></div>
            <div className="flex flex-wrap gap-2">
              {!usesProjectBrand && (
                <Button variant="ghost" onClick={() => {
                  change({ ...config, brand: projectBrand });
                  setStatus("Фирменный стиль применён к макету. Сохраните изменения.");
                }}>
                  Применить стиль проекта
                </Button>
              )}
              <Button variant="primary" onClick={() => void save()} loading={busy === "save"} disabled={!dirty}><Save className="h-4 w-4" aria-hidden />Сохранить</Button>
              <Button variant="brand" onClick={() => void renderNow()} loading={busy === "render"}><WandSparkles className="h-4 w-4" aria-hidden />Собрать PNG</Button>
            </div>
          </div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2"><Field label="Название макета" htmlFor="design-name"><Input id="design-name" value={config.name} maxLength={160} onChange={(event) => change({ ...config, name: event.target.value })} /></Field><Field label="Формат" htmlFor="design-format"><select id="design-format" className={SELECT_CLASS} value={config.format} onChange={(event) => change({ ...config, format: event.target.value as Format })}><option value="1:1">Квадрат 1:1</option><option value="4:5">Лента 4:5</option><option value="9:16">Истории 9:16</option></select></Field></div>
          <div className="mt-5 flex gap-3 overflow-x-auto pb-2">
            <ul className="flex gap-3" aria-label="Карточки карусели">
              {config.cards.map((card) => <li key={card.id} className="shrink-0"><button type="button" aria-current={card.id === active.id ? "true" : undefined} onClick={() => setActiveCardId(card.id)} className={cn("min-h-14 min-w-44 rounded-sm border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15", card.id === active.id ? "border-brand bg-info-soft text-info-text" : "border-line bg-surface-2 text-text-2 hover:border-line-strong")}><span className="block text-[11px] font-bold uppercase">Карточка {card.order}</span><span className="mt-1 block max-w-40 truncate text-[13px] font-semibold">{card.title}</span></button></li>)}
            </ul>
            {config.cards.length < 7 && <Button variant="ghost" className="min-w-36 shrink-0" onClick={() => { const next = addSemanticCarouselCard(config.cards); if (!next) { setError("Не удалось подобрать следующую смысловую роль карточки."); return; } change({ ...config, cards: next.cards }); setActiveCardId(next.added.id); }}><Plus className="h-4 w-4" aria-hidden />Добавить карточку</Button>}
          </div>
        </Card>

        <Card className="p-5 md:p-6" onKeyDown={(event) => { if (!event.altKey) return; if (event.key === "ArrowUp") { event.preventDefault(); move(-1); } if (event.key === "ArrowDown") { event.preventDefault(); move(1); } }}>
          <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-lg font-bold text-text">Карточка {active.order}</h3><div className="flex gap-1"><Button size="icon" variant="ghost" aria-label="Переместить карточку выше" disabled={activeIndex === 0} onClick={() => move(-1)}><ArrowUp className="h-4 w-4" aria-hidden /></Button><Button size="icon" variant="ghost" aria-label="Переместить карточку ниже" disabled={activeIndex === config.cards.length - 1} onClick={() => move(1)}><ArrowDown className="h-4 w-4" aria-hidden /></Button><Button size="icon" variant="ghost" aria-label="Удалить карточку" disabled={config.cards.length <= 3} onClick={() => { const cards = config.cards.filter((card) => card.id !== active.id).map((card, index) => ({ ...card, order: index + 1 })); change({ ...config, cards }); setActiveCardId(cards[Math.min(activeIndex, cards.length - 1)].id); }}><Trash2 className="h-4 w-4" aria-hidden /></Button></div></div>
          <p className="mt-1 text-[12px] text-text-3">Alt + ↑/↓ меняет порядок с клавиатуры.</p>
          <div className="mt-5 grid gap-4 sm:grid-cols-2"><Field label="Шаблон" htmlFor="card-template"><select id="card-template" className={SELECT_CLASS} value={active.template} onChange={(event) => changeCard({ template: event.target.value as Template })}>{TEMPLATES.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></Field><Field label="Надзаголовок" htmlFor="card-eyebrow"><Input id="card-eyebrow" value={active.eyebrow} maxLength={160} onChange={(event) => changeCard({ eyebrow: event.target.value })} /></Field></div>
          <div className="mt-4"><Field label="Заголовок" htmlFor="card-title"><Textarea id="card-title" rows={2} value={active.title} maxLength={1200} aria-invalid={layoutIssues.some((issue) => issue.cardId === active.id && issue.field === "title") || undefined} onChange={(event) => changeCard({ title: event.target.value })} /></Field></div>
          <fieldset className="mt-4 space-y-3"><legend className="text-[13px] font-semibold text-text-2">Тезисы</legend>{active.theses.map((thesis, index) => <div key={`${active.id}-edit-${index}`} className="flex items-start gap-2"><Textarea aria-label={`Тезис ${index + 1}`} aria-invalid={layoutIssues.some((issue) => issue.cardId === active.id && issue.field === "theses") || undefined} rows={2} value={thesis} onChange={(event) => changeCard({ theses: active.theses.map((item, itemIndex) => itemIndex === index ? event.target.value : item) })} /><Button size="icon" variant="ghost" aria-label={`Удалить тезис ${index + 1}`} disabled={active.theses.length <= 1} onClick={() => changeCard({ theses: active.theses.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 className="h-4 w-4" aria-hidden /></Button></div>)}{active.theses.length < 10 && <Button size="sm" variant="ghost" onClick={() => changeCard({ theses: [...active.theses, "Новый тезис"] })}><Plus className="h-4 w-4" aria-hidden />Добавить тезис</Button>}</fieldset>
          <div className="mt-4 grid gap-4 sm:grid-cols-2"><Field label="Призыв к действию" htmlFor="card-cta" hint="Оставьте пустым, если кнопка не нужна."><Input id="card-cta" value={active.cta?.label ?? ""} maxLength={400} onChange={(event) => changeCard({ cta: event.target.value ? { label: event.target.value, url: active.cta?.url ?? null } : null })} /></Field><Field label="Примечание об источнике" htmlFor="card-source"><Input id="card-source" value={active.sourceNote} maxLength={500} onChange={(event) => changeCard({ sourceNote: event.target.value })} /></Field></div>
          <div className="mt-4"><Field label="Изображение" htmlFor="card-image" hint="Файл должен принадлежать выбранному проекту."><select id="card-image" className={SELECT_CLASS} value={active.image?.assetId ?? ""} onChange={(event) => { const asset = assets.find((item) => item.id === Number(event.target.value)); changeCard({ image: asset ? { assetId: String(asset.id), alt: asset.metadata.alt || asset.fileName, mimeType: asset.mimeType, width: asset.width || 1, height: asset.height || 1, sha256: asset.sha256 } : null }); }}><option value="">Без изображения</option>{assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.fileName}</option>)}</select></Field></div>
          <form className="mt-3 flex flex-wrap items-center gap-3" onSubmit={async (event) => { event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement); setBusy("upload"); setError(""); try { const result = await json<{ asset: MediaAsset }>("/api/media/assets", { method: "POST", body: form }); onAssets([result.asset, ...assets.filter((item) => item.id !== result.asset.id)]); changeCard({ image: { assetId: String(result.asset.id), alt: result.asset.metadata.alt || result.asset.fileName, mimeType: result.asset.mimeType, width: result.asset.width || 1, height: result.asset.height || 1, sha256: result.asset.sha256 } }); formElement.reset(); } catch (nextError) { setError(errorLabel(nextError)); } finally { setBusy(null); } }}><label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xs border border-line-strong bg-surface px-3.5 py-2 text-[13px] font-semibold text-text hover:bg-surface-inset focus-within:ring-4 focus-within:ring-brand/15"><Upload className="h-4 w-4" aria-hidden /><span>Загрузить изображение</span><input className="sr-only" type="file" name="file" accept="image/jpeg,image/png,image/webp" required /></label><Input className="max-w-xs" name="alt" aria-label="Описание изображения" placeholder="Что изображено" maxLength={240} /><Button type="submit" size="sm" variant="soft" loading={busy === "upload"}>Добавить изображение</Button></form>
        </Card>
      </section>

      <aside className="min-w-0 space-y-5 xl:sticky xl:top-5 xl:self-start">
        <Card className="p-5 md:p-6"><div className="flex items-center justify-between gap-3"><h2 className="text-lg font-bold text-text">Предпросмотр</h2><Badge>{config.format}</Badge></div><div className="mt-5"><VisualPreview config={config} activeCardId={active.id} /></div><p className="mt-4 text-[13px] leading-relaxed text-text-3">Это быстрый предпросмотр. Итоговые файлы PNG создаёт единая серверная система сборки.</p></Card>
        {(status || error) && <Card className={cn("p-4", error ? "border border-danger-text/25 bg-danger-soft" : "border border-info-text/20 bg-info-soft")}><p role={error ? "alert" : "status"} aria-live="polite" className={cn("flex items-start gap-2 text-[13px] font-semibold", error ? "text-danger-text" : "text-info-text")}>{error ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : busy ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}{error || status}</p>{layoutIssues.length > 0 && <ul className="mt-3 space-y-2 border-t border-danger-text/15 pt-3">{layoutIssues.map((issue, index) => { const card = config.cards.find((item) => item.id === issue.cardId); const label = `${card ? `Карточка ${card.order} · ` : ""}${visualIssueFieldLabel(issue.field)}: ${issue.message || "исправьте содержимое"}`; return <li key={issue.id ?? `${issue.cardId}-${issue.field}-${index}`}><button type="button" className="min-h-11 w-full rounded-xs px-2 py-2 text-left text-[13px] leading-relaxed font-medium text-danger-text underline decoration-danger-text/35 underline-offset-4 hover:bg-danger-text/5 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-danger-text/15" onClick={() => focusIssue(issue)}>{label}</button></li>; })}</ul>}</Card>}
        {render?.status === "ready" && (
          <Card className="p-5">
            <h2 className="text-lg font-bold text-text">Готовые карточки</h2>
            <div className="mt-4 flex snap-x gap-3 overflow-x-auto pb-3">
              {render.cards.map((card) => (
                <button type="button" key={card.id} className="w-36 shrink-0 snap-start rounded-sm border border-line bg-surface-2 p-2 text-left focus-visible:ring-4 focus-visible:ring-brand/15" onClick={() => setActiveCardId(card.id)}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- authenticated project media cannot use the image optimizer */}
                  <img src={card.url} alt={`Готовая карточка ${card.order}`} className="aspect-[4/5] w-full rounded-xs object-cover" />
                  <span className="mt-2 block text-[12px] font-semibold text-text">Карточка {card.order}</span>
                </button>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="brand" onClick={() => {
                sessionStorage.setItem("aurora:generated-media", JSON.stringify({
                  kind: "carousel",
                  label: config.name,
                  hue: 255,
                  renderOperationId: render.id,
                  items: render.cards.map((card) => ({
                    assetId: String(card.assetId),
                    label: `${config.name} · карточка ${card.order}`,
                    url: card.url,
                    mimeType: "image/png",
                  })),
                }));
                const returnSuffix = returnTo ? `&returnTo=${returnTo}` : "";
                router.push(draftId
                  ? `/app/composer?draft=${draftId}&fromMedia=1&from=studio-visuals${returnSuffix}`
                  : `/app/composer?fromMedia=1&from=studio-visuals${returnSuffix}`);
              }}>
                Добавить всю карусель в пост
              </Button>
              <Button variant="outline" onClick={() => {
                const card = render.cards.find((item) => item.id === activeCardId) ?? render.cards[0];
                if (!card) return;
                sessionStorage.setItem("aurora:generated-media", JSON.stringify({ kind: "image", label: `${config.name} · карточка ${card.order}`, hue: 255, assetId: String(card.assetId), url: card.url, mimeType: "image/png" }));
                const returnSuffix = returnTo ? `&returnTo=${returnTo}` : "";
                router.push(draftId
                  ? `/app/composer?draft=${draftId}&fromMedia=1&from=studio-visuals${returnSuffix}`
                  : `/app/composer?fromMedia=1&from=studio-visuals${returnSuffix}`);
              }}>
                Только выбранную
              </Button>
              {render.cards.map((card) => <a key={`download-${card.id}`} href={`${card.url}?download=1`} download aria-label={`Скачать карточку ${card.order}`} className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[10px] px-3.5 py-2 text-[13px] font-semibold text-text-2 transition-colors hover:bg-surface-inset hover:text-text focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15"><Download className="h-4 w-4" aria-hidden />{card.order}</a>)}
            </div>
            <p className="mt-3 text-[12px] leading-relaxed text-text-3">Telegram опубликует карточки одним альбомом и сохранит их порядок. Для VK карусель пока доступна только как набор файлов.</p>
          </Card>
        )}
      </aside>
    </div>
  );
}

function editableScenes(script: VideoScriptRecord | null): VideoScene[] {
  return script?.script.scenes.map((scene) => ({
    id: scene.id,
    order: scene.order,
    role: scene.role,
    durationSeconds: scene.durationSeconds,
    voiceOver: scene.voiceOver,
    onScreenText: scene.onScreenText,
    visualDirection: scene.visualDirection,
    sourceClaimIds: [...scene.sourceClaimIds],
  })) ?? [];
}

function rebalanceScenes(scenes: VideoScene[], totalSeconds: 30 | 45 | 60): VideoScene[] {
  if (scenes.length === 0) return scenes;
  const base = Math.floor(totalSeconds / scenes.length);
  const remainder = totalSeconds - (base * scenes.length);
  return scenes.map((scene, index) => ({
    ...scene,
    durationSeconds: base + (index < remainder ? 1 : 0),
  }));
}

function VideoStudio({ draftId, scripts, onScripts }: { draftId: number | null; scripts: VideoScriptRecord[]; onScripts: (scripts: VideoScriptRecord[]) => void }) {
  const initialScript = scripts[0] ?? null;
  const [selectedId, setSelectedId] = useState<number | null>(initialScript?.id ?? null);
  const selected = scripts.find((item) => item.id === selectedId) ?? null;
  const [draftValue, setDraftValue] = useState(draftId ? String(draftId) : "");
  const [duration, setDuration] = useState<30 | 45 | 60>(initialScript?.durationSeconds ?? 30);
  const [newDuration, setNewDuration] = useState<30 | 45 | 60>(30);
  const [title, setTitle] = useState(initialScript?.title ?? "");
  const [scenes, setScenes] = useState<VideoScene[]>(() => editableScenes(initialScript));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const selectScript = (script: VideoScriptRecord) => {
    setSelectedId(script.id);
    setTitle(script.title);
    setDuration(script.durationSeconds);
    setScenes(editableScenes(script));
    setError("");
    setStatus("");
  };
  return <div className="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]"><Card className="h-fit p-4"><h2 className="text-[13px] font-bold tracking-wide text-text-3 uppercase">Сценарии</h2><div className="mt-3 space-y-2">{scripts.map((script) => <button key={script.id} type="button" aria-current={script.id === selectedId ? "true" : undefined} onClick={() => selectScript(script)} className={cn("min-h-12 w-full rounded-xs border px-3 py-2 text-left focus-visible:ring-4 focus-visible:ring-brand/15", script.id === selectedId ? "border-brand bg-info-soft" : "border-line bg-surface-2")}><span className="block truncate text-[13px] font-semibold text-text">{script.title}</span><span className="text-[11px] text-text-3">{script.durationSeconds} сек. · версия {script.revision}</span></button>)}</div><div className="mt-5 space-y-3"><Field label="Номер черновика" htmlFor="video-draft"><Input id="video-draft" inputMode="numeric" value={draftValue} onChange={(event) => setDraftValue(event.target.value.replace(/\D/gu, ""))} /></Field><Field label="Продолжительность" htmlFor="new-video-duration"><select id="new-video-duration" className={SELECT_CLASS} value={newDuration} onChange={(event) => setNewDuration(Number(event.target.value) as 30 | 45 | 60)}><option value={30}>30 секунд</option><option value={45}>45 секунд</option><option value={60}>60 секунд</option></select></Field><Button variant="brand" className="w-full" loading={busy} disabled={!Number(draftValue)} onClick={async () => { setBusy(true); setError(""); try { const result = await json<{ script: VideoScriptRecord }>("/api/legal-video-scripts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ draftId: Number(draftValue), durationSeconds: newDuration, requestKey: requestKey("video") }) }); onScripts([result.script, ...scripts.filter((item) => item.id !== result.script.id)]); selectScript(result.script); setStatus("Сценарий создан из зафиксированной версии черновика"); } catch (nextError) { setError(errorLabel(nextError)); } finally { setBusy(false); } }}><Clapperboard className="h-4 w-4" aria-hidden />Новый сценарий</Button></div></Card>
    <section aria-label="Редактор сценария">{selected ? <Card className="p-5 md:p-7"><div className="flex flex-wrap items-start justify-between gap-4"><div><Badge tone="brand">Короткое видео</Badge><h2 className="mt-3 text-2xl font-bold tracking-tight text-text">{selected.title}</h2><p className="mt-1 text-[13px] text-text-3">Каждый факт привязан к точной ревизии исходного черновика.</p></div><div className="flex flex-wrap gap-2"><a href={`/api/legal-video-scripts/${selected.id}/production-brief`} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xs border border-line-strong bg-surface px-5 text-[15px] font-semibold text-text transition-colors hover:bg-surface-inset focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15"><Download className="h-4 w-4" aria-hidden />Скачать техзадание</a><Button variant="brand" loading={busy} onClick={async () => { setBusy(true); setError(""); setStatus("Проверяем сцены и источники…"); try { const result = await json<{ script: VideoScriptRecord }>(`/api/legal-video-scripts/${selected.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: selected.revision, title, durationSeconds: duration, scenes }) }); onScripts(scripts.map((item) => item.id === result.script.id ? result.script : item)); setStatus("Сценарий сохранён"); } catch (nextError) { setError(errorLabel(nextError)); setStatus(""); } finally { setBusy(false); } }}><Save className="h-4 w-4" aria-hidden />Сохранить</Button></div></div><div className="mt-6 grid gap-4 sm:grid-cols-2"><Field label="Название" htmlFor="script-title"><Input id="script-title" value={title} maxLength={180} onChange={(event) => setTitle(event.target.value)} /></Field><Field label="Хронометраж" htmlFor="script-duration"><select id="script-duration" className={SELECT_CLASS} value={duration} onChange={(event) => { const next = Number(event.target.value) as 30 | 45 | 60; setDuration(next); setScenes(rebalanceScenes(scenes, next)); }}><option value={30}>30 секунд</option><option value={45}>45 секунд</option><option value={60}>60 секунд</option></select></Field></div><ol className="mt-6 space-y-4">{scenes.map((scene, index) => <li key={scene.id} className="rounded-sm border border-line bg-surface-2 p-4"><div className="flex items-center justify-between gap-3"><h3 className="font-bold text-text">Сцена {scene.order} · {scene.role === "hook" ? "Начало" : scene.role === "cta" ? "Призыв" : "Основная часть"}</h3><label className="flex items-center gap-2 text-[12px] text-text-3"><span>Секунд</span><input aria-label={`Длительность сцены ${scene.order}`} className="h-11 w-20 rounded-xs border border-line bg-surface px-3 text-text" type="number" min={1} max={60} value={scene.durationSeconds} onChange={(event) => setScenes(scenes.map((item, itemIndex) => itemIndex === index ? { ...item, durationSeconds: Number(event.target.value) } : item))} /></label></div><div className="mt-4 grid gap-4 xl:grid-cols-2"><Field label="Озвучка" htmlFor={`voice-${scene.id}`}><Textarea id={`voice-${scene.id}`} rows={4} value={scene.voiceOver} onChange={(event) => setScenes(scenes.map((item, itemIndex) => itemIndex === index ? { ...item, voiceOver: event.target.value } : item))} /></Field><div className="space-y-4"><Field label="Текст на экране" htmlFor={`screen-${scene.id}`}><Textarea id={`screen-${scene.id}`} rows={2} value={scene.onScreenText} onChange={(event) => setScenes(scenes.map((item, itemIndex) => itemIndex === index ? { ...item, onScreenText: event.target.value } : item))} /></Field><Field label="Кадр и дополнительные материалы" htmlFor={`visual-${scene.id}`}><Textarea id={`visual-${scene.id}`} rows={2} value={scene.visualDirection} onChange={(event) => setScenes(scenes.map((item, itemIndex) => itemIndex === index ? { ...item, visualDirection: event.target.value } : item))} /></Field></div></div></li>)}</ol>{(status || error) && <p role={error ? "alert" : "status"} aria-live="polite" className={cn("mt-5 flex items-center gap-2 text-[13px] font-semibold", error ? "text-danger-text" : "text-success-text")}>{error ? <AlertTriangle className="h-4 w-4" aria-hidden /> : <CheckCircle2 className="h-4 w-4" aria-hidden />}{error || status}</p>}</Card> : <Card className="p-8 text-center"><Clapperboard className="mx-auto h-9 w-9 text-text-3" aria-hidden /><h2 className="mt-4 text-xl font-bold text-text">Создайте сценарий из черновика</h2><p className="mx-auto mt-2 max-w-lg text-[14px] leading-relaxed text-text-3">Аврора разложит материал на начало, озвучку, экранный текст, дополнительные кадры и призыв. Новые факты без основания будут заблокированы.</p>{error && <p role="alert" className="mt-4 text-[13px] font-semibold text-danger-text">{error}</p>}</Card>}</section></div>;
}

function BrandKitPanel({
  value,
  version,
  assets,
  onAssets,
  onSaved,
}: {
  value: Brand;
  version: number;
  assets: MediaAsset[];
  onAssets: (assets: MediaAsset[]) => void;
  onSaved: (brand: Brand, version: number) => void;
}) {
  const [brand, setBrand] = useState(value);
  const [busy, setBusy] = useState<"save" | "upload" | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const logoIsInLibrary = brand.logo
    ? assets.some((asset) => String(asset.id) === brand.logo?.assetId)
    : false;
  const colorLabels: Record<keyof Brand["colors"], string> = {
    background: "Фон",
    surface: "Карточки",
    text: "Основной текст",
    mutedText: "Вторичный текст",
    accent: "Акцент",
    critical: "Предупреждение",
  };

  const selectLogo = (assetId: string) => {
    if (!assetId) {
      setBrand({ ...brand, logo: null });
      return;
    }
    const asset = assets.find((item) => item.id === Number(assetId));
    if (!asset) return;
    setBrand({
      ...brand,
      logo: mediaAssetToVisualReference(asset, `Логотип ${brand.name || "проекта"}`),
    });
  };

  const saveBrand = async () => {
    setBusy("save");
    setError("");
    setStatus("Сохраняем фирменный стиль…");
    try {
      const result = await json<{ brand: Brand; version: number }>("/api/legal-visuals/brand-kit", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: version, brand }),
      });
      setBrand(result.brand);
      onSaved(result.brand, result.version);
      setStatus("Фирменный стиль сохранён");
    } catch (nextError) {
      setError(errorLabel(nextError));
      setStatus("");
    } finally {
      setBusy(null);
    }
  };

  return (
    <details className="rounded-md border border-line bg-surface">
      <summary className="group flex min-h-14 cursor-pointer list-none flex-col items-start justify-center gap-1 px-4 py-3 font-semibold text-text focus-visible:ring-4 focus-visible:ring-brand/15 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-5 [&::-webkit-details-marker]:hidden">
        <span>Фирменный стиль проекта</span>
        <span className="flex min-w-0 items-center gap-2 text-[12px] leading-snug font-medium text-text-3 sm:text-end">
          <span>логотип, цвета, шрифты и подпись</span>
          <ChevronDown className="h-4 w-4 shrink-0 group-open:rotate-180" aria-hidden />
        </span>
      </summary>
      <div className="border-t border-line p-4 sm:p-5">
        <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(280px,0.56fr)]">
          <div className="min-w-0 space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Название бренда" htmlFor="brand-name">
                <Input id="brand-name" value={brand.name} maxLength={100} onChange={(event) => setBrand({ ...brand, name: event.target.value })} />
              </Field>
              <Field label="Подпись на карточках" htmlFor="brand-signature">
                <Input id="brand-signature" value={brand.signature} maxLength={160} onChange={(event) => setBrand({ ...brand, signature: event.target.value })} />
              </Field>
            </div>

            <fieldset>
              <legend className="text-[13px] font-semibold text-text-2">Разрешённые шрифты</legend>
              <p id="brand-fonts-hint" className="mt-1 max-w-2xl text-[13px] leading-relaxed text-text-3">
                Оставьте только шрифты, которыми команда может оформлять визуалы. Нужен хотя бы один; один из выбранных используется в новых макетах.
              </p>
              <div className="mt-2 grid gap-x-5 sm:grid-cols-2 lg:grid-cols-3" aria-describedby="brand-fonts-hint">
                {LEGAL_VISUAL_FONT_OPTIONS.map((option) => {
                  const checked = brand.allowedFonts.includes(option.key);
                  return (
                    <Checkbox
                      key={option.key}
                      id={`allowed-font-${option.key}`}
                      checked={checked}
                      disabled={checked && brand.allowedFonts.length === 1}
                      label={option.label}
                      onChange={(enabled) => {
                        const next = toggleAllowedVisualFont({
                          allowedFonts: brand.allowedFonts,
                          activeFont: brand.font,
                          font: option.key,
                          enabled,
                        });
                        setBrand({ ...brand, allowedFonts: next.allowedFonts, font: next.activeFont });
                      }}
                    />
                  );
                })}
              </div>
              <div className="mt-3 max-w-sm">
                <Field label="Шрифт новых макетов" htmlFor="brand-font">
                  <select id="brand-font" className={SELECT_CLASS} value={brand.font} onChange={(event) => setBrand({ ...brand, font: event.target.value as Brand["font"] })}>
                    {LEGAL_VISUAL_FONT_OPTIONS.filter((option) => brand.allowedFonts.includes(option.key)).map((option) => (
                      <option key={option.key} value={option.key}>{option.label}</option>
                    ))}
                  </select>
                </Field>
              </div>
            </fieldset>
          </div>

          <section aria-labelledby="brand-logo-heading" className="min-w-0 rounded-sm bg-surface-2 p-4">
            <h3 id="brand-logo-heading" className="text-[15px] font-bold text-text">Логотип проекта</h3>
            <p className="mt-1 text-[13px] leading-relaxed text-text-3">Выберите изображение из медиатеки или загрузите PNG, JPEG либо WebP до 10 МБ.</p>
            <div className="mt-4 flex min-h-24 items-center justify-center rounded-sm bg-surface p-3 outline outline-1 outline-white/10">
              {brand.logo ? (
                // eslint-disable-next-line @next/next/no-img-element -- authenticated project media cannot use the image optimizer
                <img src={`/api/media/assets/${brand.logo.assetId}`} alt={brand.logo.alt} className="max-h-24 max-w-full object-contain" />
              ) : (
                <p className="text-center text-[13px] text-text-3">Логотип не выбран</p>
              )}
            </div>
            <div className="mt-4">
              <Field label="Изображение из медиатеки" htmlFor="brand-logo" hint="PNG, JPEG или WebP из выбранного проекта.">
                <select id="brand-logo" className={SELECT_CLASS} value={brand.logo?.assetId ?? ""} onChange={(event) => selectLogo(event.target.value)}>
                  <option value="">Без логотипа</option>
                  {brand.logo && !logoIsInLibrary && <option value={brand.logo.assetId}>Текущий логотип</option>}
                  {assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.fileName}</option>)}
                </select>
              </Field>
            </div>
            <form className="mt-4 space-y-3" onSubmit={async (event) => {
              event.preventDefault();
              const formElement = event.currentTarget;
              const form = new FormData(formElement);
              setBusy("upload");
              setError("");
              setStatus("Загружаем логотип…");
              try {
                const result = await json<{ asset: MediaAsset }>("/api/media/assets", { method: "POST", body: form });
                onAssets([result.asset, ...assets.filter((item) => item.id !== result.asset.id)]);
                setBrand({
                  ...brand,
                  logo: mediaAssetToVisualReference(result.asset, `Логотип ${brand.name || "проекта"}`),
                });
                setStatus("Логотип загружен. Сохраните фирменный стиль.");
                formElement.reset();
              } catch (nextError) {
                setError(errorLabel(nextError));
                setStatus("");
              } finally {
                setBusy(null);
              }
            }}>
              <label className="inline-flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xs border border-line-strong bg-surface px-3.5 py-2 text-[13px] font-semibold text-text hover:bg-surface-inset focus-within:ring-4 focus-within:ring-brand/15 sm:w-auto">
                <Upload className="h-4 w-4" aria-hidden />
                <span>Выбрать файл</span>
                <input className="sr-only" type="file" name="file" accept="image/jpeg,image/png,image/webp" required />
              </label>
              <Input name="alt" aria-label="Описание логотипа" placeholder="Например: логотип юридического бюро" maxLength={240} />
              <Button type="submit" size="sm" variant="soft" loading={busy === "upload"} className="w-full sm:w-auto">Загрузить логотип</Button>
            </form>
          </section>
        </div>

        <fieldset className="mt-6">
          <legend className="text-[15px] font-bold text-text">Цвета</legend>
          <div className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {(["background", "surface", "text", "mutedText", "accent", "critical"] as const).map((key) => (
              <Field key={key} label={colorLabels[key]} htmlFor={`brand-${key}`}>
                <div className="flex min-w-0 gap-2">
                  <input
                    id={`brand-${key}`}
                    type="color"
                    aria-label={`${colorLabels[key]}: выбрать цвет`}
                    className="h-12 w-14 shrink-0 cursor-pointer rounded-xs border border-line bg-surface p-1"
                    value={brand.colors[key]}
                    onChange={(event) => setBrand({ ...brand, colors: { ...brand.colors, [key]: event.target.value } })}
                  />
                  <Input
                    aria-label={`${colorLabels[key]}: шестизначный код цвета`}
                    value={brand.colors[key]}
                    maxLength={7}
                    pattern="#[0-9a-fA-F]{6}"
                    onChange={(event) => setBrand({ ...brand, colors: { ...brand.colors, [key]: event.target.value.toLowerCase() } })}
                  />
                </div>
              </Field>
            ))}
          </div>
        </fieldset>

        <div className="mt-6 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
          <Button variant="primary" loading={busy === "save"} onClick={() => void saveBrand()} className="w-full sm:w-auto">
            <Save className="h-4 w-4" aria-hidden />
            Сохранить фирменный стиль
          </Button>
          <div className="min-h-5 min-w-0" aria-live="polite">
            {(status || error) && (
              <p role={error ? "alert" : "status"} className={cn("text-[13px] leading-relaxed font-semibold", error ? "text-danger-text" : "text-text-3")}>
                {error || status}
              </p>
            )}
          </div>
        </div>
      </div>
    </details>
  );
}

function LegalVisualStudioInner() {
  const params = useSearchParams();
  const draftId = Number(params.get("draft")) || null;
  const returnTo = params.get("returnTo") === "autopilot-month"
    ? "autopilot-month"
    : params.get("returnTo") === "studio"
      ? "studio"
      : params.get("returnTo") === "calendar"
        ? "calendar"
      : null;
  const [designs, setDesigns] = useState<Design[]>([]);
  const [selectedDesignId, setSelectedDesignId] = useState<number | null>(null);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [scripts, setScripts] = useState<VideoScriptRecord[]>([]);
  const [brand, setBrand] = useState<{ value: Brand; version: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const selected = designs.find((item) => item.id === selectedDesignId) ?? null;
  useEffect(() => { let cancelled = false; Promise.all([
    json<{ designs: Design[] }>("/api/legal-visuals"),
    json<{ assets: MediaAsset[] }>("/api/media/assets"),
    json<{ scripts: VideoScriptRecord[] }>("/api/legal-video-scripts"),
    json<{ brand: Brand; version: number }>("/api/legal-visuals/brand-kit"),
  ]).then(([visualData, mediaData, videoData, brandData]) => { if (cancelled) return; setDesigns(visualData.designs); setSelectedDesignId(visualData.designs[0]?.id ?? null); setAssets(mediaData.assets); setScripts(videoData.scripts); setBrand({ value: brandData.brand, version: brandData.version }); }).catch((nextError) => { if (!cancelled) setError(errorLabel(nextError)); }).finally(() => { if (!cancelled) setLoading(false); }); return () => { cancelled = true; }; }, []);
  return <AppShell title="Карусели и сценарии" subtitle="Собирайте карусели и сценарии коротких видео из проверяемых материалов.">
    <div className="mx-auto w-full max-w-[1500px] space-y-5">
      {brand && <BrandKitPanel value={brand.value} version={brand.version} assets={assets} onAssets={setAssets} onSaved={(value, version) => setBrand({ value, version })} />}
      {loading ? <Card className="flex min-h-80 items-center justify-center p-8"><p role="status" className="flex items-center gap-2 text-[14px] text-text-3"><Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden />Загружаем визуальную студию…</p></Card> : error ? <Card className="p-8 text-center"><AlertTriangle className="mx-auto h-8 w-8 text-danger-text" aria-hidden /><p role="alert" className="mt-4 font-semibold text-danger-text">{error}</p></Card> : <>
        <section aria-labelledby="carousel-heading" className="space-y-5">
          <div className="flex items-center gap-2">
            <Layers3 className="h-5 w-5 text-brand" aria-hidden />
            <h2 id="carousel-heading" className="text-xl font-bold text-text">Карусели</h2>
          </div>
          {designs.length > 0 && <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center"><label htmlFor="existing-design" className="text-[13px] font-semibold text-text-2">Макет</label><select id="existing-design" className={cn(SELECT_CLASS, "min-w-0 sm:max-w-sm")} value={selectedDesignId ?? ""} onChange={(event) => setSelectedDesignId(Number(event.target.value))}>{designs.map((design) => <option key={design.id} value={design.id}>{design.name} · версия {design.revision}</option>)}</select><Button variant="ghost" size="sm" onClick={() => setSelectedDesignId(null)}><Plus className="h-4 w-4" aria-hidden />Новый макет</Button></div>}
          {selected && brand ? <VisualEditor key={selected.id} design={selected} draftId={draftId} returnTo={returnTo} assets={assets} projectBrand={brand.value} onAssets={setAssets} onDesign={(next) => { setDesigns(designs.map((item) => item.id === next.id ? next : item)); setSelectedDesignId(next.id); }} /> : <EmptyIntro draftId={draftId} onCreated={(next) => { setDesigns([next, ...designs]); setSelectedDesignId(next.id); }} />}
        </section>
        <section aria-labelledby="video-scripts-heading" className="space-y-5 pt-5">
          <div className="flex items-center gap-2">
            <Clapperboard className="h-5 w-5 text-brand" aria-hidden />
            <h2 id="video-scripts-heading" className="text-xl font-bold text-text">Сценарии видео</h2>
          </div>
          <VideoStudio draftId={draftId} scripts={scripts} onScripts={setScripts} />
        </section>
      </>}
    </div>
  </AppShell>;
}

export default function LegalVisualStudioPage() {
  return <Suspense fallback={<AppShell title="Карусели и сценарии" subtitle="Загружаем редактор…"><Card className="min-h-80" /></AppShell>}><LegalVisualStudioInner /></Suspense>;
}
