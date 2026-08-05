"use client";

import { useMemo, useState } from "react";
import { ArrowRight, Check, ExternalLink, Library, Search, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Input, Tabs } from "@/components/ui/primitives";
import type { RankedRssSource, RssCatalogCategory } from "@/lib/rss-catalog";
import { cn } from "@/lib/utils";

type ConnectedFeed = { id: number; url: string; channel_id: number; channel_title: string | null };
type CatalogView = "recommended" | "all";

export type RssCatalogContext = {
  channelTitle: string;
  niche: string | null;
  personalized: boolean;
};

const CATEGORIES: Array<RssCatalogCategory | "Все темы"> = [
  "Все темы",
  "Технологии",
  "Бизнес",
  "Финансы",
  "Право",
  "Маркетинг",
  "Наука",
];

function normalizedUrl(value: string) {
  return value.trim().replace(/\/$/, "").toLocaleLowerCase("ru-RU");
}

export function SourceCatalog({
  sources,
  context,
  channelId,
  feeds,
  loading,
  error,
  connectingId,
  onConnect,
  onRetry,
}: {
  sources: RankedRssSource[];
  context: RssCatalogContext | null;
  channelId: number | null;
  feeds: ConnectedFeed[];
  loading: boolean;
  error: boolean;
  connectingId: string | null;
  onConnect: (source: RankedRssSource) => void;
  onRetry: () => void;
}) {
  const [view, setView] = useState<CatalogView>("recommended");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<RssCatalogCategory | "Все темы">("Все темы");
  const [confirmMoveKey, setConfirmMoveKey] = useState<string | null>(null);

  const recommendedCount = sources.filter((source) => source.recommended).length;
  const visibleSources = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("ru-RU");
    return sources.filter((source) => {
      if (view === "recommended" && !source.recommended) return false;
      if (category !== "Все темы" && source.category !== category) return false;
      if (!normalizedQuery) return true;
      return `${source.title} ${source.description} ${source.category}`
        .toLocaleLowerCase("ru-RU")
        .includes(normalizedQuery);
    });
  }, [category, query, sources, view]);

  return (
    <Card as="section" className="overflow-hidden" aria-labelledby="source-catalog-title">
      <div className="border-b-2 border-line bg-surface-inset p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center border-2 border-line bg-[var(--acc)]">
            <Library className="h-5 w-5" strokeWidth={2.3} aria-hidden />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="source-catalog-title" className="text-[16px] font-black text-text">Готовые источники</h2>
              <Badge tone="brand">Подборка по каналу</Badge>
            </div>
            <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-text-2">
              Выбери из каталога — источник добавится на паузе. ИИ начнёт отсеивать и адаптировать новости только после отдельного включения автопубликации.
            </p>
          </div>
        </div>
      </div>

      {context && (
        <div className="flex items-start gap-2.5 border-b-2 border-line px-5 py-3.5">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p className="text-[12px] leading-relaxed text-text-2">
            {context.personalized ? (
              <>
                Подборка учитывает профиль <strong className="text-text">«{context.channelTitle}»</strong>
                {context.niche ? <>: {context.niche}</> : "."}
              </>
            ) : (
              <>
                Пока ориентируемся на название <strong className="text-text">«{context.channelTitle}»</strong>. После заполнения брифа подборка станет точнее.
              </>
            )}
          </p>
        </div>
      )}

      <div className="flex flex-col gap-3 border-b-2 border-line p-4 sm:p-5 xl:flex-row xl:items-center xl:justify-between">
        <Tabs
          value={view}
          onChange={setView}
          items={[
            { value: "recommended", label: `Для вас ${recommendedCount}` },
            { value: "all", label: `Весь каталог ${sources.length}` },
          ]}
        />

        <div className="flex flex-col gap-2 sm:flex-row">
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value as RssCatalogCategory | "Все темы")}
            aria-label="Категория источников"
            className="h-10 min-w-40 bg-surface px-2 text-[12px] font-bold text-text"
          >
            {CATEGORIES.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <div className="relative min-w-0 sm:min-w-64">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-text-3" aria-hidden />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Найти источник"
              aria-label="Поиск по каталогу"
              className="h-10 pl-9 text-[13px]"
            />
          </div>
        </div>
      </div>

      {loading ? (
        <div className="grid gap-3 p-5 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((index) => <div key={index} className="skeleton h-52" />)}
        </div>
      ) : error ? (
        <EmptyState
          icon={<Library className="h-5 w-5" />}
          title="Не удалось собрать подборку"
          body="Каталог не влияет на уже подключённые источники. Попробуй загрузить его ещё раз."
          action={<Button variant="outline" size="sm" onClick={onRetry}>Повторить</Button>}
        />
      ) : visibleSources.length === 0 ? (
        <EmptyState
          icon={<Search className="h-5 w-5" />}
          title="Ничего не найдено"
          body="Сбрось тему или попробуй более короткий запрос."
          action={
            <Button variant="outline" size="sm" onClick={() => { setQuery(""); setCategory("Все темы"); setView("all"); }}>
              Показать весь каталог
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 p-4 sm:p-5 md:grid-cols-2 xl:grid-cols-3">
          {visibleSources.map((source) => {
            const connected = feeds.find((feed) => normalizedUrl(feed.url) === normalizedUrl(source.url));
            const connectedHere = Number(connected?.channel_id) === channelId;
            const moving = Boolean(connected && !connectedHere);
            const moveKey = `${channelId}:${source.id}`;
            const confirmingMove = moving && confirmMoveKey === moveKey;
            return (
              <article
                key={source.id}
                className={cn(
                  "flex min-h-52 flex-col border-2 border-line bg-surface p-4",
                  source.recommended && "shadow-[3px_3px_0_var(--ink)]",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-wrap gap-1.5">
                    <Badge tone={source.recommended ? "brand" : "neutral"}>{source.category}</Badge>
                    <Badge tone="neutral">{source.language}</Badge>
                  </div>
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Открыть источник ${source.title}`}
                    className="inline-flex h-11 w-11 shrink-0 items-center justify-center text-text-3 transition-colors hover:bg-surface-inset hover:text-text"
                  >
                    <ExternalLink className="h-4 w-4" aria-hidden />
                  </a>
                </div>

                <h3 className="mt-4 text-[15px] font-black leading-snug text-text">{source.title}</h3>
                <p className="mt-1.5 flex-1 text-[12px] leading-relaxed text-text-2">{source.description}</p>
                <p className="mt-3 text-[11px] font-semibold text-text-3">
                  {moving ? `Сейчас подключено к «${connected?.channel_title || "другому каналу"}»` : source.reason}
                </p>

                {confirmingMove ? (
                  <div className="mt-3 border-2 border-line bg-fire-soft p-3" role="alert">
                    <p className="text-[11px] leading-relaxed text-text-2">
                      Прежний канал перестанет получать новости из этого источника.
                    </p>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <Button variant="outline" size="sm" onClick={() => setConfirmMoveKey(null)}>Отмена</Button>
                      <Button
                        variant="solid"
                        size="sm"
                        loading={connectingId === source.id}
                        onClick={() => {
                          setConfirmMoveKey(null);
                          onConnect(source);
                        }}
                      >
                        Перенести
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant={connectedHere ? "soft" : "solid"}
                    size="md"
                    className="mt-3 w-full"
                    disabled={connectedHere}
                    loading={connectingId === source.id}
                    onClick={() => moving ? setConfirmMoveKey(moveKey) : onConnect(source)}
                  >
                    {connectedHere ? (
                      <><Check className="h-4 w-4" aria-hidden />Подключено</>
                    ) : moving ? (
                      <>Перенести в этот канал<ArrowRight className="h-4 w-4" aria-hidden /></>
                    ) : (
                      <>Добавить на паузе<ArrowRight className="h-4 w-4" aria-hidden /></>
                    )}
                  </Button>
                )}
              </article>
            );
          })}
        </div>
      )}
    </Card>
  );
}
