"use client";
import { useProjectCall } from "@/lib/use-project-transport";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, FileText, RefreshCw, Sparkles, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge, Card, Field, Input, Textarea } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { articleHasQualityBlock } from "@/lib/site-articles/quality.mjs";

import { ARTICLE_STATUS_LABEL, errorMessage, formatDate, requestJson as unscopedRequestJson } from "./client";
import type { ArticleStats } from "./types";

type Article = {
  id: number;
  type: string;
  typeLabel: string;
  origin: string;
  title: string;
  slug: string;
  metaDescription: string | null;
  preview: string;
  similarity: { verdict?: string; maxScore?: number; nearestUrl?: string | null } | null;
  quality: { issues?: Array<{ code: string; severity: string; message: string }>; wordCount?: number } | null;
  version: number;
  status: string;
  statusReason: string | null;
  publishedUrl: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  bodyMarkdown?: string;
};

type Props = {
  /** Заготовка из пробела: форма создания открыта, тема и тип уже выбраны. */
  initialBrief?: { brief: string; type: string } | null;
  /** Заготовка использована: повторный вход в раздел не должен открывать форму заново. */
  onDraftConsumed?: () => void;
  siteId: number;
  verified: boolean;
  hasDestinations: boolean;
  destinationsLoaded: boolean;
  hasProfile: boolean;
  onSiteChanged: () => void;
  onStats?: (stats: ArticleStats) => void;
};

const STATUS_TONE: Record<string, "brand" | "success" | "danger" | "fire" | "neutral"> = {
  needs_review: "fire",
  approved: "brand",
  publishing: "brand",
  published: "success",
  failed: "danger",
  rejected: "neutral",
  retired: "neutral",
  draft: "neutral",
  generating: "brand",
  scheduled: "brand",
};

const MANUAL_TYPES = [
  ["audience_answer", "Ответ на вопрос"],
  ["evergreen_guide", "Гид по теме"],
  ["industry_explainer", "Разбор новости"],
  ["company_news", "Новость компании"],
  ["case_study", "Кейс"],
  ["machine_readable_page", "Страница о компании"],
] as const;

type Filter = "all" | "review" | "published";

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "Все" },
  { value: "review", label: "Ждут одобрения" },
  { value: "published", label: "Опубликованные" },
];

const REVIEW_STATUSES = new Set(["needs_review", "draft", "generating", "approved", "failed", "scheduled", "publishing"]);

function matchesFilter(article: Article, filter: Filter) {
  if (filter === "review") return REVIEW_STATUSES.has(article.status);
  if (filter === "published") return article.status === "published";
  return true;
}

export function ArticlesPanel({ initialBrief = null, onDraftConsumed, siteId, verified, hasDestinations, destinationsLoaded, hasProfile, onSiteChanged, onStats }: Props) {
  const requestJson = useProjectCall(unscopedRequestJson);
  const [articles, setArticles] = useState<Article[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<Article | null>(null);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(Boolean(initialBrief));
  const [filter, setFilter] = useState<Filter>("review");
  const [draft, setDraft] = useState({ title: "", metaDescription: "", bodyMarkdown: "" });
  const [manualType, setManualType] = useState<string>(initialBrief?.type || "audience_answer");
  const [manualBrief, setManualBrief] = useState(initialBrief?.brief || "");
  const detailRequest = useRef(0);
  // Открытая карточка должна обновиться, если список принёс более свежую версию материала,
  // но ровно один раз на изменение — иначе опрос списка превращается в шторм запросов.
  const openDetail = useRef<{ id: number; updatedAt: string | null } | null>(null);
  useEffect(() => () => { detailRequest.current += 1; }, [siteId]);

  const loadArticle = useCallback(async (id: number, request: number) => {
    const { status, body } = await requestJson<{ article?: Article; error?: string }>(`/api/sites/${siteId}/articles/${id}`);
    if (request !== detailRequest.current) return;
    if (status === 200 && body.article) {
      openDetail.current = { id: body.article.id, updatedAt: body.article.updatedAt };
      setDetail(body.article);
      setDraft({ title: body.article.title, metaDescription: body.article.metaDescription || "", bodyMarkdown: body.article.bodyMarkdown || "" });
    } else {
      setError(errorMessage(body.error, "Не удалось открыть материал."));
    }
  }, [requestJson, siteId]);

  const load = useCallback(async () => {
    try {
      const { status, body } = await requestJson<{ articles?: Article[]; error?: string }>(`/api/sites/${siteId}/articles`);
      if (status !== 200 || !body.articles) throw Object.assign(new Error("list_failed"), { code: body.error });
      setArticles(body.articles);
      setError(null);
      const opened = openDetail.current;
      if (opened) {
        const fresh = body.articles.find((item) => item.id === opened.id);
        if (fresh && fresh.updatedAt !== opened.updatedAt) {
          void loadArticle(opened.id, ++detailRequest.current);
        }
      }
      if (onStats) {
        onStats({
          total: body.articles.length,
          pending: body.articles.filter((item) => item.status === "needs_review").length,
          published: body.articles.filter((item) => item.status === "published").length,
        });
      }
    } catch (caught) {
      setError(errorMessage((caught as { code?: string }).code, "Не удалось загрузить материалы."));
    } finally {
      setLoaded(true);
    }
  }, [requestJson, siteId, onStats, loadArticle]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- state changes only after the request settles
  useEffect(() => { void load(); }, [load]);

  const active = articles.some((item) => item.status === "draft" || item.status === "generating" || item.status === "publishing");
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [active, load]);

  const openArticle = useCallback((id: number) => {
    // Повторный клик по уже открытому материалу не должен перезапрашивать его.
    if (openDetail.current?.id === id) return;
    openDetail.current = null;
    detailRequest.current += 1;
    setOpenId(id);
    setDetail(null);
    setEditing(false);
  }, []);

  const visible = useMemo(() => articles.filter((article) => matchesFilter(article, filter)), [articles, filter]);
  const pendingCount = articles.filter((item) => item.status === "needs_review").length;
  const publishedCount = articles.filter((item) => item.status === "published").length;

  // Материал выбирается сам: правая половина экрана не должна показывать пустое окно.
  // Выбор выводится из списка, а не выставляется эффектом — так нет лишнего рендера.
  const selectedId = openId !== null && visible.some((item) => item.id === openId)
    ? openId
    : visible[0]?.id ?? null;

  useEffect(() => {
    if (selectedId === null || detail?.id === selectedId) return;
    const request = ++detailRequest.current;
    void loadArticle(selectedId, request);
  }, [selectedId, detail?.id, loadArticle]);

  const act = useCallback(async (id: number, action: string, payload: Record<string, unknown> = {}) => {
    setBusy(`${id}:${action}`);
    setError(null);
    const { status, body } = await requestJson<{ article?: Article; error?: string }>(`/api/sites/${siteId}/articles/${id}`, {
      method: "POST",
      body: JSON.stringify({ action, ...payload }),
    });
    setBusy(null);
    if (status >= 400) {
      setError(errorMessage(body.error, "Действие не выполнено."));
      return;
    }
    // Одобрение на неподтверждённом домене не публикует материал, а только готовит его:
    // сообщаем об этом честно, вместо молчаливого «ничего не произошло».
    if (action === "approve" && !verified) {
      setError("Материал одобрен внутри Авроры. Публикация начнётся после подтверждения домена.");
    }
    await load();
    if (body.article) setDetail(body.article);
    // Публикация и одобрение меняют состояние сайта — обновляем и карточку сайта.
    if (action === "approve" || action === "update" || action === "unpublish") onSiteChanged();
  }, [requestJson, siteId, load, verified, onSiteChanged]);

  const plan = useCallback(async () => {
    setBusy("plan");
    setError(null);
    const { status, body } = await requestJson<{ error?: string }>(`/api/sites/${siteId}/articles`, { method: "POST", body: JSON.stringify({ plan: true }) });
    setBusy(null);
    if (status >= 400) setError(errorMessage(body.error, "Не удалось запустить планирование."));
    else setTimeout(() => void load(), 4000);
  }, [requestJson, siteId, load]);

  const createManual = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy("manual");
    setError(null);
    const { status, body } = await requestJson<{ error?: string }>(`/api/sites/${siteId}/articles`, {
      method: "POST",
      body: JSON.stringify({ articleType: manualType, brief: manualBrief.trim() }),
    });
    setBusy(null);
    if (status >= 400) {
      setError(errorMessage(body.error, "Не удалось создать материал."));
      return;
    }
    setManualBrief("");
    setCreating(false);
    onDraftConsumed?.();
    await load();
  }, [requestJson, siteId, manualType, manualBrief, load, onDraftConsumed]);

  const saveEdit = useCallback(async () => {
    if (!detail) return;
    setBusy(`${detail.id}:edit`);
    setError(null);
    const { status, body } = await requestJson<{ article?: Article; error?: string }>(`/api/sites/${siteId}/articles/${detail.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: draft.title, metaDescription: draft.metaDescription, bodyMarkdown: draft.bodyMarkdown }),
    });
    setBusy(null);
    if (status >= 400) {
      setError(errorMessage(body.error, "Не удалось сохранить правку."));
      return;
    }
    setEditing(false);
    if (body.article) setDetail(body.article);
    await load();
  }, [detail, draft, requestJson, siteId, load]);

  const detailView = detail && selectedId === detail.id ? detail : null;

  return (
    <div className="space-y-4">
      {error && <p role="alert" className="type-secondary rounded-sm bg-danger-soft p-4 text-danger-text">{error}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex gap-1 rounded-sm border border-line bg-surface-inset p-1" role="tablist" aria-label="Фильтр материалов">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={filter === item.value}
              onClick={() => setFilter(item.value)}
              className={cn(
                "type-button inline-flex min-h-11 items-center gap-1.5 rounded-[9px] px-3.5 py-2 transition-colors",
                filter === item.value ? "bg-surface text-text shadow-soft" : "text-text-2 hover:text-text",
              )}
            >
              {item.label}
              {loaded && (
                <span className={cn("rounded-full px-1.5 py-0.5 text-[11px] font-bold leading-none", filter === item.value ? "bg-info-soft text-info-text" : "bg-surface text-text-2")}>
                  {item.value === "all" ? articles.length : item.value === "review" ? pendingCount : publishedCount}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={plan} disabled={busy === "plan" || !hasProfile}>
            <Sparkles className={cn("h-4 w-4", busy === "plan" && "animate-spin")} aria-hidden />
            {busy === "plan" ? "Планируем…" : "Спланировать сейчас"}
          </Button>
          <Button type="button" size="sm" onClick={() => setCreating((value) => !value)} disabled={!hasProfile} aria-expanded={creating}>
            {creating ? "Отменить" : "Новый материал"}
          </Button>
        </div>
      </div>

      {!hasProfile && <p className="type-caption text-fire-text">Материалы появятся после аудита: Аврора опирается на профиль сайта.</p>}
      {!verified && <p className="type-caption text-fire-text">Домен не подтверждён — материалы можно готовить и одобрять, отправка на сайт включится после подтверждения.</p>}
      {verified && destinationsLoaded && !hasDestinations && (
        <p className="type-caption text-fire-text">Назначение публикации не подключено — материалы будут ждать в Авроре.</p>
      )}

      {/* Форма создания появляется по кнопке: постоянная панель над списком только занимала место */}
      {creating && (
        <Card className="p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="type-h3 text-text">Новый материал</h3>
              <p className="type-caption mt-1 text-text-3">Аврора возьмёт факты только из базы знаний сайта — придумывать за компанию не будет.</p>
            </div>
          </div>
          <form className="mt-4 grid gap-3 md:grid-cols-[220px_minmax(0,1fr)_auto]" onSubmit={createManual}>
            <Field label="Тип материала" htmlFor="manual-type">
              <select
                id="manual-type"
                value={manualType}
                onChange={(event) => setManualType(event.target.value)}
                className="type-input w-full rounded-sm border border-line bg-surface px-3 py-2.5 text-text"
              >
                {MANUAL_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            <Field label="О чём написать" htmlFor="manual-brief" hint="Тема или вопрос клиента. Минимум 10 символов.">
              <Input
                id="manual-brief"
                value={manualBrief}
                onChange={(event) => setManualBrief(event.target.value)}
                placeholder="Например: сколько длится процедура банкротства и от чего зависит срок"
              />
            </Field>
            <div className="flex items-end">
              <Button type="submit" disabled={busy === "manual" || manualBrief.trim().length < 10 || !hasProfile}>
                {busy === "manual" ? "Создаём…" : "Создать"}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {!loaded ? (
        <Card className="p-5"><p role="status" className="type-secondary text-text-2">Загружаем материалы…</p></Card>
      ) : visible.length === 0 ? (
        <Card className="p-6">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-sm bg-info-soft text-brand">
              <FileText className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <p className="type-body-strong text-text">
                {articles.length === 0 ? "Материалов пока нет" : "В этом фильтре материалов нет"}
              </p>
              <p className="type-secondary mt-1 text-text-2">
                {articles.length === 0
                  ? "Нажмите «Спланировать сейчас» — Аврора предложит темы по пробелам профиля."
                  : "Переключите фильтр: остальные материалы видны во вкладке «Все»."}
              </p>
            </div>
          </div>
        </Card>
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[380px_minmax(0,1fr)]">
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
              <span className="type-label text-text-2">Материалы сайта</span>
              <span className="type-caption text-text-3">{pendingCount} ждут решения</span>
            </div>
            <ul className="max-h-[720px] overflow-auto">
              {visible.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => openArticle(item.id)}
                    aria-current={selectedId === item.id ? "true" : undefined}
                    className={cn(
                      "flex w-full flex-col gap-1.5 border-t border-line px-5 py-4 text-left transition first:border-t-0 hover:bg-surface-2",
                      "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15",
                      selectedId === item.id && "bg-info-soft/60 shadow-[inset_3px_0_0_0_var(--brand-1)]",
                    )}
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge tone={STATUS_TONE[item.status] || "neutral"}>{ARTICLE_STATUS_LABEL[item.status] || item.status}</Badge>
                      <span className="type-caption text-text-3">{item.typeLabel}</span>
                      {item.similarity?.verdict === "warn" && <Badge tone="fire">похоже на страницу сайта</Badge>}
                    </span>
                    <span className="type-body-strong text-text">{item.title || "Без названия (генерируется)"}</span>
                    {item.preview && <span className="type-caption line-clamp-2 text-text-2">{item.preview}</span>}
                    <span className="type-caption text-text-3">
                      v{item.version} · {formatDate(item.updatedAt, true)}
                      {item.statusReason ? ` · ${item.statusReason}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            {!detailView ? (
              <p role="status" className="type-secondary p-6 text-text-2">Открываем материал…</p>
            ) : (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4 sm:px-6">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={STATUS_TONE[detailView.status] || "neutral"}>{ARTICLE_STATUS_LABEL[detailView.status] || detailView.status}</Badge>
                      <span className="type-caption text-text-3">
                        {detailView.typeLabel} · v{detailView.version} · {detailView.quality?.wordCount ?? "—"} слов
                      </span>
                      {detailView.publishedUrl && (
                        <a href={detailView.publishedUrl} target="_blank" rel="noopener noreferrer" className="type-caption inline-flex items-center gap-1 text-brand">
                          <ExternalLink className="h-3.5 w-3.5" aria-hidden />открыть на сайте
                        </a>
                      )}
                    </div>
                    <h3 className="type-h3 mt-2 text-text">{detailView.title}</h3>
                    {detailView.metaDescription && <p className="type-secondary mt-1 text-text-2">{detailView.metaDescription}</p>}
                    <p className="type-caption mt-1 text-text-3">
                      Обновлён {formatDate(detailView.updatedAt, true)}
                      {detailView.statusReason ? ` · ${detailView.statusReason}` : ""}
                    </p>
                  </div>
                </div>

                <div className="grid border-line lg:grid-cols-[minmax(0,1fr)_280px] [&>div+div]:border-t lg:[&>div+div]:border-t-0 lg:[&>div+div]:border-l">
                  <div className="px-5 py-5 sm:px-6">
                    {editing ? (
                      <div className="space-y-3">
                        <Field label="Заголовок" htmlFor="edit-title">
                          <Input id="edit-title" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
                        </Field>
                        <Field label="Description" htmlFor="edit-meta">
                          <Input id="edit-meta" value={draft.metaDescription} onChange={(event) => setDraft({ ...draft, metaDescription: event.target.value })} />
                        </Field>
                        <Field label="Текст (Markdown)" htmlFor="edit-body">
                          <Textarea id="edit-body" rows={20} value={draft.bodyMarkdown} onChange={(event) => setDraft({ ...draft, bodyMarkdown: event.target.value })} />
                        </Field>
                        <p className="type-caption text-text-3">Правка обнуляет серию одобрений без правок — это защита автоматического режима.</p>
                      </div>
                    ) : (
                      <pre className="type-secondary max-h-[520px] overflow-auto whitespace-pre-wrap rounded-sm bg-surface-inset p-4 text-text">
                        {detailView.bodyMarkdown || "Текст ещё генерируется."}
                      </pre>
                    )}
                  </div>

                  <div className="px-5 py-5 sm:px-6">
                    <p className="type-label text-text-2">Проверки перед публикацией</p>
                    <ul className="mt-3 space-y-3">
                      <li className="flex gap-2">
                        <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-sm", detailView.similarity?.verdict === "warn" ? "bg-fire-soft text-fire-text" : "bg-success-soft text-success-text")}>
                          {detailView.similarity?.verdict === "warn" ? <XCircle className="h-3.5 w-3.5" aria-hidden /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
                        </span>
                        <span className="type-caption text-text-2">
                          {detailView.similarity?.verdict === "warn"
                            ? `Похоже на ${detailView.similarity.nearestUrl ? "страницу сайта" : "существующую страницу"} (близость ${detailView.similarity.maxScore})`
                            : `Дублей не нашлось (близость ${detailView.similarity?.maxScore ?? "—"})`}
                        </span>
                      </li>
                      {(detailView.quality?.issues ?? []).map((issue, index) => (
                        <li key={`${issue.code}-${index}`} className="flex gap-2">
                          <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-sm", issue.severity === "error" ? "bg-danger-soft text-danger-text" : "bg-fire-soft text-fire-text")}>
                            <XCircle className="h-3.5 w-3.5" aria-hidden />
                          </span>
                          <span className="type-caption text-text-2">{issue.message}</span>
                        </li>
                      ))}
                      {(detailView.quality?.issues ?? []).length === 0 && (
                        <li className="flex gap-2">
                          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-sm bg-success-soft text-success-text"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden /></span>
                          <span className="type-caption text-text-2">Замечаний по качеству нет</span>
                        </li>
                      )}
                    </ul>
                    {detailView.similarity?.nearestUrl && detailView.similarity.verdict !== "ok" && (
                      <p className="type-caption mt-3">
                        <a href={detailView.similarity.nearestUrl} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                          Посмотреть похожую страницу
                        </a>
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-4 sm:px-6">
                  {editing ? (
                    <>
                      <Button type="button" size="sm" onClick={saveEdit} disabled={busy === `${detailView.id}:edit`}>
                        {busy === `${detailView.id}:edit` ? "Сохраняем…" : "Сохранить как новую версию"}
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Отмена</Button>
                    </>
                  ) : (
                    <>
                      {["needs_review", "approved", "failed"].includes(detailView.status) && (
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => act(detailView.id, "approve")}
                          disabled={busy !== null || articleHasQualityBlock(detailView)}
                        >
                          <CheckCircle2 className="h-4 w-4" aria-hidden />
                          {detailView.status === "approved" ? "Опубликовать" : "Одобрить"}
                        </Button>
                      )}
                      {["needs_review", "approved", "failed"].includes(detailView.status) && (
                        <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(true)}>
                          Править текст
                        </Button>
                      )}
                      {["needs_review", "approved", "failed", "draft"].includes(detailView.status) && (
                        <Button type="button" size="sm" variant="ghost" onClick={() => act(detailView.id, "reject", { reason: "rejected_by_reviewer" })} disabled={busy !== null}>
                          <XCircle className="h-4 w-4" aria-hidden />Отклонить
                        </Button>
                      )}
                      {["failed", "rejected"].includes(detailView.status) && (
                        <Button type="button" size="sm" variant="secondary" onClick={() => act(detailView.id, "regenerate")} disabled={busy !== null}>
                          <RefreshCw className="h-4 w-4" aria-hidden />Сгенерировать заново
                        </Button>
                      )}
                      {detailView.status === "published" && (
                        <>
                          <Button type="button" size="sm" variant="secondary" onClick={() => act(detailView.id, "update")} disabled={busy !== null}>Обновить на сайте</Button>
                          <Button type="button" size="sm" variant="ghost" onClick={() => act(detailView.id, "unpublish")} disabled={busy !== null}>Снять с публикации</Button>
                        </>
                      )}
                      {!verified && (
                        <span className="type-caption ml-auto text-text-3">
                          Одобрение на неподтверждённом домене только готовит материал к публикации
                        </span>
                      )}
                    </>
                  )}
                </div>
              </>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
