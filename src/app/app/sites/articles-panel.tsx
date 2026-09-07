"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, FileText, RefreshCw, Sparkles, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge, Card, Field, Input, Textarea } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

import { ARTICLE_STATUS_LABEL, errorMessage, formatDate, requestJson } from "./client";

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
  siteId: number;
  verified: boolean;
  hasDestinations: boolean;
  hasProfile: boolean;
  onSiteChanged: () => void;
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

export function ArticlesPanel({ siteId, verified, hasDestinations, hasProfile, onSiteChanged }: Props) {
  const [articles, setArticles] = useState<Article[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<{ siteId: number; articleId: number; message: string } | null>(null);
  const [refreshAttempt, setRefreshAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<Article | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: "", metaDescription: "", bodyMarkdown: "" });
  const draftRef = useRef(draft);
  const updateDraft = useCallback((value: typeof draft) => { draftRef.current = value; setDraft(value); }, []);
  const [manualType, setManualType] = useState<string>("audience_answer");
  const [manualBrief, setManualBrief] = useState("");
  const openRequest = useRef(0);
  const siteEpoch = useRef(0);
  useEffect(() => () => { openRequest.current += 1; siteEpoch.current += 1; }, [siteId]);

  const load = useCallback(async () => {
    const owner = siteEpoch.current;
    try {
      const { status, body } = await requestJson<{ articles?: Article[]; error?: string }>(`/api/sites/${siteId}/articles`);
      if (owner !== siteEpoch.current) return;
      if (status !== 200 || !body.articles) throw Object.assign(new Error("list_failed"), { code: body.error });
      setArticles(body.articles);
      setError(null);
    } catch (caught) {
      if (owner !== siteEpoch.current) return;
      setError(errorMessage((caught as { code?: string }).code, "Не удалось загрузить материалы."));
    } finally {
      if (owner === siteEpoch.current) setLoaded(true);
    }
  }, [siteId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- state changes only after the request settles
  useEffect(() => { void load(); }, [load]);

  const active = articles.some((item) => item.status === "draft" || item.status === "generating" || item.status === "publishing");
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [active, load]);

  const openArticle = useCallback(async (id: number) => {
    const request = ++openRequest.current;
    setOpenId(id);
    setEditing(false);
    setDetailError(null);
    const { status, body } = await requestJson<{ article?: Article; error?: string }>(`/api/sites/${siteId}/articles/${id}`);
    if (request !== openRequest.current) return;
    if (status === 200 && body.article?.id === id) {
      setDetail(body.article);
      setArticles((current) => current.map((article) => article.id === id ? body.article! : article));
      updateDraft({ title: body.article.title, metaDescription: body.article.metaDescription || "", bodyMarkdown: body.article.bodyMarkdown || "" });
    }
  }, [siteId, updateDraft]);

  const listedOpenArticle = articles.find((article) => article.id === openId);
  const listedVersion = listedOpenArticle?.version;
  const listedStatus = listedOpenArticle?.status;
  useEffect(() => {
    if (openId === null || detail?.id !== openId || editing || busy !== null || listedStatus === undefined) return;
    if (detail.version === listedVersion && detail.status === listedStatus) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const failed = (message: string) => {
      if (cancelled) return;
      setDetailError({ siteId, articleId: openId, message });
      // Retry only after a settled failure. List polling must not cancel a slow
      // detail request, and a terminal list may no longer have its own timer.
      retryTimer = setTimeout(() => setRefreshAttempt((attempt) => attempt + 1), 4000);
    };
    // Polling reads summaries. Fetch the full current revision before changing the
    // opened article or editor; a later selection/edit invalidates this response.
    void requestJson<{ article?: Article; error?: string }>(`/api/sites/${siteId}/articles/${openId}`).then(({ status, body }) => {
      if (cancelled) return;
      if (status !== 200 || body.article?.id !== openId) {
        failed(errorMessage(body.error, "Не удалось обновить состояние материала."));
        return;
      }
      setDetail(body.article);
      updateDraft({ title: body.article.title, metaDescription: body.article.metaDescription || "", bodyMarkdown: body.article.bodyMarkdown || "" });
      setDetailError(null);
    }).catch(() => { failed("Не удалось обновить состояние материала."); });
    return () => { cancelled = true; clearTimeout(retryTimer); };
  }, [siteId, openId, detail?.id, detail?.version, detail?.status, listedVersion, listedStatus, editing, busy, refreshAttempt, updateDraft]);

  const act = useCallback(async (id: number, action: string, extra: Record<string, unknown> = {}) => {
    if (busy !== null || editing) return;
    const request = ++openRequest.current;
    const reviewed = detail?.id === id ? detail : articles.find((article) => article.id === id);
    if (!reviewed) return;
    setBusy(`${id}:${action}`);
    setError(null);
    const { status, body } = await requestJson<{ error?: string }>(`/api/sites/${siteId}/articles/${id}`, {
      method: "POST",
      body: JSON.stringify({ ...extra, action, version: reviewed.version, status: reviewed.status }),
    });
    setBusy(null);
    if (request !== openRequest.current) return;
    if (status >= 400) {
      setError(errorMessage(body.error, "Действие не выполнено."));
      return;
    }
    if (openId === id) await openArticle(id);
    onSiteChanged();
  }, [siteId, openId, openArticle, onSiteChanged, detail, articles, busy, editing]);

  const saveEdit = useCallback(async () => {
    if (!detail || busy !== null) return;
    const request = ++openRequest.current;
    const submitted = { ...draftRef.current };
    const busyKey = `${detail.id}:edit`;
    setBusy(busyKey);
    const { status, body } = await requestJson<{ article?: Article; error?: string; issues?: Array<{ message: string; severity: string }> }>(`/api/sites/${siteId}/articles/${detail.id}`, {
      method: "PATCH",
      body: JSON.stringify({ ...submitted, version: detail.version, status: detail.status }),
    });
    setBusy((current) => current === busyKey ? null : current);
    if (request !== openRequest.current) return;
    if (status >= 400 || body.article?.id !== detail.id) {
      setError(errorMessage(body.error, "Не удалось сохранить правку."));
      return;
    }
    const saved = body.article;
    setDetail(saved);
    setArticles((current) => current.map((article) => article.id === saved.id ? saved : article));
    setError(null);
    setDetailError(null);
    const current = draftRef.current;
    if (current.title === submitted.title && current.metaDescription === submitted.metaDescription && current.bodyMarkdown === submitted.bodyMarkdown) {
      updateDraft({ title: saved.title, metaDescription: saved.metaDescription || "", bodyMarkdown: saved.bodyMarkdown || "" });
      setEditing(false);
    }
  }, [detail, siteId, updateDraft, busy]);

  const plan = useCallback(async () => {
    if (busy !== null) return;
    const owner = siteEpoch.current;
    setBusy("plan");
    setError(null);
    const { status, body } = await requestJson<{ error?: string }>(`/api/sites/${siteId}/articles`, { method: "POST", body: JSON.stringify({ plan: true }) });
    setBusy(null);
    if (owner !== siteEpoch.current) return;
    if (status >= 400) setError(errorMessage(body.error, "Не удалось запустить планирование."));
    else setTimeout(() => { if (owner === siteEpoch.current) void load(); }, 1500);
  }, [siteId, load, busy]);

  const createManual = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy !== null) return;
    const owner = siteEpoch.current;
    const submitted = manualBrief;
    setBusy("manual");
    setError(null);
    const { status, body } = await requestJson<{ error?: string }>(`/api/sites/${siteId}/articles`, {
      method: "POST",
      body: JSON.stringify({ articleType: manualType, brief: manualBrief }),
    });
    setBusy(null);
    if (owner !== siteEpoch.current) return;
    if (status >= 400) {
      setError(errorMessage(body.error, "Не удалось создать материал."));
      return;
    }
    setManualBrief((current) => current === submitted ? "" : current);
    await load();
  }, [siteId, manualType, manualBrief, load, busy]);

  const visibleError = error ?? (detailError?.siteId === siteId && detailError.articleId === openId ? detailError.message : null);
  const pending = articles.filter((item) => item.status === "needs_review").length;

  return (
    <div className="space-y-6">
      {visibleError && <p role="alert" className="type-secondary rounded-sm bg-danger-soft p-4 text-danger-text">{visibleError}</p>}
      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="type-h3 text-text">Материалы для сайта</h3>
            <p className="type-secondary mt-1 text-text-2">
              Аврора планирует материалы по профилю сайта раз в день. Каждый материал ждёт одобрения; в очереди сейчас: {pending}.
            </p>
            {!verified && <p className="type-caption mt-2 text-fire-text">Домен не подтверждён — материалы можно одобрять, но публикация откроется после подтверждения.</p>}
            {verified && !hasDestinations && <p className="type-caption mt-2 text-fire-text">Нет настроенного назначения — добавь WordPress или включи раздел на вкладке «Публикация».</p>}
          </div>
          <Button type="button" size="sm" variant="secondary" onClick={plan} disabled={busy !== null || !hasProfile}>
            <Sparkles className="h-4 w-4" aria-hidden />Спланировать сейчас
          </Button>
        </div>
        <form className="mt-5 grid gap-3 rounded-sm border border-line bg-surface-2 p-4 md:grid-cols-[200px_minmax(0,1fr)_auto]" onSubmit={createManual}>
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
          <Field label="О чём написать" htmlFor="manual-brief" hint="Тема или вопрос клиента. Факты о компании Аврора возьмёт только из базы знаний сайта.">
            <Input id="manual-brief" value={manualBrief} onChange={(event) => setManualBrief(event.target.value)} placeholder="Например: сколько длится лечение и от чего зависит срок" />
          </Field>
          <div className="flex items-end">
            <Button type="submit" size="md" disabled={busy !== null || manualBrief.trim().length < 10 || !hasProfile}>Создать</Button>
          </div>
        </form>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card className="overflow-hidden">
          {!loaded ? (
            <p className="type-secondary p-5 text-text-2">Загружаем…</p>
          ) : articles.length === 0 ? (
            <div className="p-6 text-center">
              <FileText className="mx-auto h-6 w-6 text-text-3" aria-hidden />
              <p className="type-body-strong mt-2 text-text">Материалов пока нет</p>
              <p className="type-secondary mt-1 text-text-2">Нажми «Спланировать сейчас» или создай материал вручную.</p>
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {articles.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => void openArticle(item.id)}
                    aria-current={openId === item.id ? "true" : undefined}
                    className={cn("flex w-full flex-col gap-1.5 px-5 py-4 text-left transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15", openId === item.id && "bg-info-soft/60")}
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge tone={STATUS_TONE[item.status] || "neutral"}>{ARTICLE_STATUS_LABEL[item.status] || item.status}</Badge>
                      <span className="type-caption text-text-3">{item.typeLabel}</span>
                      {item.similarity?.verdict === "warn" && <Badge tone="fire">похоже на существующую страницу</Badge>}
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
          )}
        </Card>

        <Card className="p-5 sm:p-6">
          {!detail || openId !== detail.id ? (
            <p className="type-secondary text-text-2">Выбери материал слева, чтобы прочитать, поправить и одобрить.</p>
          ) : (
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={STATUS_TONE[detail.status] || "neutral"}>{ARTICLE_STATUS_LABEL[detail.status] || detail.status}</Badge>
                <span className="type-caption text-text-3">{detail.typeLabel} · v{detail.version} · {detail.quality?.wordCount ?? "—"} слов</span>
                {detail.publishedUrl && (
                  <a href={detail.publishedUrl} target="_blank" rel="noopener noreferrer" className="type-caption inline-flex items-center gap-1 text-brand">
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden />открыть на сайте
                  </a>
                )}
              </div>
              {detail.similarity && detail.similarity.verdict !== "ok" && (
                <p className="type-caption mt-3 rounded-sm bg-fire-soft p-3 text-fire-text">
                  Похоже на {detail.similarity.nearestUrl ? <a href={detail.similarity.nearestUrl} className="underline" target="_blank" rel="noopener noreferrer">существующую страницу</a> : "существующую страницу"} (близость {detail.similarity.maxScore}).
                </p>
              )}
              {detail.quality?.issues?.length ? (
                <ul className="mt-3 space-y-1">
                  {detail.quality.issues.map((issue, index) => (
                    <li key={`${issue.code}-${index}`} className={cn("type-caption", issue.severity === "error" ? "text-danger-text" : "text-text-3")}>• {issue.message}</li>
                  ))}
                </ul>
              ) : null}

              {editing ? (
                <div className="mt-4 space-y-3">
                  <Field label="Заголовок" htmlFor="edit-title"><Input id="edit-title" value={draft.title} onChange={(event) => updateDraft({ ...draft, title: event.target.value })} /></Field>
                  <Field label="Description" htmlFor="edit-meta"><Input id="edit-meta" value={draft.metaDescription} onChange={(event) => updateDraft({ ...draft, metaDescription: event.target.value })} /></Field>
                  <Field label="Текст (Markdown)" htmlFor="edit-body"><Textarea id="edit-body" rows={18} value={draft.bodyMarkdown} onChange={(event) => updateDraft({ ...draft, bodyMarkdown: event.target.value })} /></Field>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" className="h-auto min-w-0 max-w-full" onClick={saveEdit} disabled={busy !== null}>
                      <span className="min-w-0 whitespace-normal">Сохранить как новую версию</span>
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => { openRequest.current += 1; setEditing(false); }}>Отмена</Button>
                  </div>
                  <p className="type-caption text-text-3">Правка обнуляет серию одобрений без правок — это защита автоматического режима.</p>
                </div>
              ) : (
                <>
                  <h3 className="type-h3 mt-4 text-text">{detail.title}</h3>
                  {detail.metaDescription && <p className="type-secondary mt-1 text-text-2">{detail.metaDescription}</p>}
                  <pre className="type-secondary mt-4 max-h-[480px] overflow-auto whitespace-pre-wrap rounded-sm bg-surface-inset p-4 text-text">{detail.bodyMarkdown}</pre>
                </>
              )}

              <div className="mt-5 flex flex-wrap gap-2">
                {["needs_review", "approved", "failed"].includes(detail.status) && (
                  <Button type="button" size="sm" onClick={() => act(detail.id, detail.status === "approved" ? "publish" : "approve")} disabled={busy !== null || editing}>
                    <CheckCircle2 className="h-4 w-4" aria-hidden />{detail.status === "approved" ? "Опубликовать" : "Одобрить"}
                  </Button>
                )}
                {["needs_review", "approved", "failed"].includes(detail.status) && !editing && (
                  <Button type="button" size="sm" variant="secondary" onClick={() => { openRequest.current += 1; setEditing(true); }}>Править</Button>
                )}
                {["needs_review", "approved", "failed", "draft"].includes(detail.status) && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => act(detail.id, "reject", { reason: "rejected_by_reviewer" })} disabled={busy !== null || editing}>
                    <XCircle className="h-4 w-4" aria-hidden />Отклонить
                  </Button>
                )}
                {["failed", "rejected"].includes(detail.status) && (
                  <Button type="button" size="sm" variant="secondary" onClick={() => act(detail.id, "regenerate")} disabled={busy !== null || editing}>
                    <RefreshCw className="h-4 w-4" aria-hidden />Сгенерировать заново
                  </Button>
                )}
                {detail.status === "published" && (
                  <>
                    <Button type="button" size="sm" variant="secondary" onClick={() => act(detail.id, "update")} disabled={busy !== null || editing}>Обновить на сайте</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => act(detail.id, "unpublish")} disabled={busy !== null || editing}>Снять с публикации</Button>
                  </>
                )}
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
