"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  CirclePause,
  ExternalLink,
  FileCheck2,
  Filter,
  Link2,
  ListFilter,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Rss,
  ShieldCheck,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import styles from "./rss-variants.module.css";

export type RssVariant = 1 | 2 | 3 | 4;

type SourceState = "ok" | "paused" | "error";
type QueueState = "scheduled" | "draft";
type DecisionState = "created" | "skipped";

type Source = {
  id: number;
  name: string;
  short: string;
  url: string;
  active: boolean;
  ai: boolean;
  includeExisting: boolean;
  limit: number;
  state: SourceState;
  lastCheck: string;
  created: number;
  skipped: number;
};

type QueueItem = {
  id: number;
  sourceId: number;
  source: string;
  title: string;
  time: string;
  state: QueueState;
};

type Decision = {
  id: number;
  sourceId: number;
  source: string;
  title: string;
  time: string;
  state: DecisionState;
  result: string;
  reason: string;
};

const VARIANTS = [
  { name: "Командный центр", job: "Всё нужное на одном экране" },
  { name: "Конвейер", job: "Работать с потоком материалов" },
  { name: "По источникам", job: "Управлять каждой лентой отдельно" },
  { name: "Фокус-режим", job: "Одна задача за раз" },
] as const;

const INITIAL_SOURCES: Source[] = [
  {
    id: 1,
    name: "КонсультантПлюс",
    short: "КП",
    url: "consultant.ru/rss/news.xml",
    active: true,
    ai: true,
    includeExisting: false,
    limit: 3,
    state: "ok",
    lastCheck: "8 минут назад",
    created: 1,
    skipped: 2,
  },
  {
    id: 2,
    name: "Хабр",
    short: "Х",
    url: "habr.com/ru/rss/articles",
    active: true,
    ai: true,
    includeExisting: false,
    limit: 2,
    state: "ok",
    lastCheck: "8 минут назад",
    created: 2,
    skipped: 4,
  },
  {
    id: 3,
    name: "TechCrunch",
    short: "TC",
    url: "techcrunch.com/feed",
    active: false,
    ai: false,
    includeExisting: false,
    limit: 1,
    state: "error",
    lastCheck: "вчера",
    created: 0,
    skipped: 0,
  },
];

const INITIAL_QUEUE: QueueItem[] = [
  { id: 1, sourceId: 1, source: "КонсультантПлюс", title: "ВС уточнил правила взыскания судебных расходов", time: "13:30", state: "scheduled" },
  { id: 2, sourceId: 2, source: "Хабр", title: "Как небольшие команды внедряют ИИ", time: "13:45", state: "scheduled" },
  { id: 3, sourceId: 2, source: "Хабр", title: "Обзор юридических ИИ-инструментов", time: "18:00", state: "draft" },
];

const INITIAL_DECISIONS: Decision[] = [
  { id: 1, sourceId: 1, source: "КонсультантПлюс", title: "ВС уточнил правила взыскания судебных расходов", time: "09:42", state: "created", result: "Сегодня, 13:30", reason: "Подходит теме канала, факты сохранены, лимит не исчерпан." },
  { id: 2, sourceId: 2, source: "Хабр", title: "Как небольшие команды внедряют ИИ без отдельного отдела", time: "09:31", state: "created", result: "Сегодня, 13:45", reason: "Адаптирован под голос канала и поставлен после предыдущего поста." },
  { id: 3, sourceId: 2, source: "Хабр", title: "Новый релиз инструмента мониторинга", time: "09:18", state: "skipped", result: "Не по теме", reason: "Техническая новость не связана с юридической тематикой канала." },
  { id: 4, sourceId: 1, source: "КонсультантПлюс", title: "Изменения в статистической отчётности", time: "08:57", state: "skipped", result: "Уже обработан", reason: "Запись уже сохранена в журнале, повторный пост не создан." },
];

const CATALOG = [
  { name: "РБК Технологии", short: "РБК", url: "https://rssexport.rbc.ru/rbcnews/news/30/full.rss" },
  { name: "vc.ru", short: "VC", url: "https://vc.ru/rss/all" },
  { name: "CNews", short: "CN", url: "https://www.cnews.ru/inc/rss/news.xml" },
];

function useRssWorkspace() {
  const [sources, setSources] = useState<Source[]>(INITIAL_SOURCES);
  const [queue, setQueue] = useState<QueueItem[]>(INITIAL_QUEUE);
  const [decisions, setDecisions] = useState<Decision[]>(INITIAL_DECISIONS);
  const [checking, setChecking] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [notice, setNotice] = useState("Все изменения в прототипе применяются сразу");
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const activeSources = sources.filter((source) => source.active).length;
  const issues = sources.filter((source) => source.state === "error").length;

  const patchSource = (id: number, patch: Partial<Source>) => {
    setSources((current) => current.map((source) => source.id === id ? { ...source, ...patch } : source));
    setNotice("Настройки применятся со следующей проверки");
  };

  const toggleSource = (id: number) => {
    const source = sources.find((item) => item.id === id);
    if (!source) return;
    const active = !source.active;
    setSources((current) => current.map((item) => item.id === id ? { ...item, active, state: active ? "ok" : "paused", lastCheck: active ? "ждёт проверки" : item.lastCheck } : item));
    if (!active) {
      setQueue((current) => current.filter((item) => item.sourceId !== id));
      setDecisions((current) => [{ id: Date.now(), sourceId: id, source: source.name, title: "Ожидающие публикации источника", time: "сейчас", state: "skipped", result: "Отменены при паузе", reason: "Автопубликация остановлена вручную. Уже опубликованные посты не изменены." }, ...current]);
      setNotice(`«${source.name}» остановлен. Ожидающие RSS-посты сняты с расписания`);
    } else {
      setNotice(`«${source.name}» включён и ждёт безопасной первой проверки`);
    }
  };

  const deleteSource = (id: number) => {
    const source = sources.find((item) => item.id === id);
    if (!source) return;
    setSources((current) => current.filter((item) => item.id !== id));
    setQueue((current) => current.filter((item) => item.sourceId !== id));
    setDecisions((current) => current.filter((item) => item.sourceId !== id));
    setConfirmDeleteId(null);
    setNotice(`«${source.name}» и его журнал удалены; созданные ранее посты сохранены`);
  };

  const addSource = (payload: { name: string; short: string; url: string; ai: boolean; includeExisting: boolean; limit: number }) => {
    const normalized = payload.url.trim().replace(/\/$/, "").toLowerCase();
    if (sources.some((source) => source.url.replace(/\/$/, "").toLowerCase() === normalized)) {
      setNotice("Этот источник уже подключён к каналу");
      return false;
    }
    setSources((current) => [...current, { id: Date.now(), ...payload, active: false, state: "paused", lastCheck: "ещё не проверялся", created: 0, skipped: 0 }]);
    setNotice(`«${payload.name}» проверен и добавлен на паузе — публикаций без запуска не будет`);
    setAddOpen(false);
    return true;
  };

  const runCheck = () => {
    if (checking) return;
    if (!activeSources) {
      setNotice("Сначала включи хотя бы один источник");
      return;
    }
    setChecking(true);
    setNotice("Проверяем активные ленты…");
    window.setTimeout(() => {
      const source = sources.find((item) => item.active) ?? sources[0];
      setSources((current) => current.map((item) => item.active ? { ...item, lastCheck: "только что" } : item));
      setDecisions((current) => [{ id: Date.now(), sourceId: source.id, source: source.name, title: "Новых подходящих записей нет", time: "сейчас", state: "skipped", result: "Проверка завершена", reason: "Все найденные записи уже были обработаны или не соответствуют теме канала." }, ...current]);
      setChecking(false);
      setNotice("Проверка завершена: новых публикаций нет");
    }, 650);
  };

  return {
    sources,
    queue,
    decisions,
    checking,
    addOpen,
    notice,
    confirmDeleteId,
    activeSources,
    issues,
    setAddOpen,
    setConfirmDeleteId,
    patchSource,
    toggleSource,
    deleteSource,
    addSource,
    runCheck,
  };
}

type Workspace = ReturnType<typeof useRssWorkspace>;

function Brand() {
  return <Link href="/" className={styles.brand} aria-label="На главную Авроры"><span>А</span><strong>Аврора</strong></Link>;
}

function VariantNav({ active }: { active: RssVariant }) {
  return (
    <header className={styles.variantNav}>
      <Brand />
      <div className={styles.variantIdentity}><small>RSS · функциональные модели</small><strong>{VARIANTS[active - 1].name}</strong></div>
      <nav aria-label="Четыре функциональных варианта RSS">
        {VARIANTS.map((variant, index) => {
          const number = (index + 1) as RssVariant;
          return <Link key={variant.name} href={`/rss/${number}`} aria-current={number === active ? "page" : undefined} aria-label={`${number}. ${variant.name}`}><span>{String(number).padStart(2, "0")}</span><small>{variant.job}</small></Link>;
        })}
      </nav>
      <Link className={styles.currentLink} href="/app/rss">Текущий RSS <ArrowRight aria-hidden /></Link>
    </header>
  );
}

function ProductHeader({ workspace, label }: { workspace: Workspace; label: string }) {
  return (
    <header className={styles.productHeader}>
      <div className={styles.productMark}><span>А</span><strong>RSS</strong><i /> <small>{label}</small></div>
      <div className={styles.productActions}>
        <button type="button" className={styles.channelButton}>ТехнологИИ Права <ChevronDown aria-hidden /></button>
        <button type="button" className={styles.secondaryButton} disabled={workspace.checking} onClick={workspace.runCheck}><RefreshCw aria-hidden className={workspace.checking ? styles.spinning : undefined} />{workspace.checking ? "Проверяем" : "Проверить сейчас"}</button>
        <button type="button" className={styles.primaryButton} onClick={() => workspace.setAddOpen(true)}><Plus aria-hidden />Источник</button>
      </div>
    </header>
  );
}

function Notice({ text }: { text: string }) {
  return <div className={styles.notice} role="status"><ShieldCheck aria-hidden /><span>{text}</span></div>;
}

function StateDot({ state }: { state: SourceState }) {
  return <i className={styles.stateDot} data-state={state} aria-hidden />;
}

function SourceSettings({ source, workspace, compact = false }: { source: Source; workspace: Workspace; compact?: boolean }) {
  const deleting = workspace.confirmDeleteId === source.id;
  return (
    <div className={styles.sourceSettings} data-compact={compact || undefined}>
      <label><span>Голос канала</span><input type="checkbox" checked={source.ai} onChange={(event) => workspace.patchSource(source.id, { ai: event.target.checked })} /></label>
      <label><span>Лимит</span><select aria-label={`Лимит для ${source.name}`} value={source.limit} onChange={(event) => workspace.patchSource(source.id, { limit: Number(event.target.value) })}>{[1, 2, 3, 4, 5, 6, 10].map((value) => <option key={value} value={value}>{value} / 24ч</option>)}</select></label>
      <button type="button" className={source.active ? styles.pauseButton : styles.playButton} onClick={() => workspace.toggleSource(source.id)}>{source.active ? <Pause aria-hidden /> : <Play aria-hidden />}{source.active ? "Пауза" : "Запустить"}</button>
      <button type="button" className={styles.deleteButton} aria-label={`Удалить ${source.name}`} onClick={() => workspace.setConfirmDeleteId(deleting ? null : source.id)}><Trash2 aria-hidden /></button>
      {deleting && <div className={styles.deleteConfirm} role="alert"><span>Удалить ленту и её журнал?</span><button type="button" onClick={() => workspace.setConfirmDeleteId(null)}>Отмена</button><button type="button" onClick={() => workspace.deleteSource(source.id)}>Удалить</button></div>}
    </div>
  );
}

function AddSourcePanel({ workspace }: { workspace: Workspace }) {
  const [mode, setMode] = useState<"catalog" | "url">("catalog");
  const [url, setUrl] = useState("");
  const [ai, setAi] = useState(true);
  const [includeExisting, setIncludeExisting] = useState(false);
  const [limit, setLimit] = useState(3);
  const [error, setError] = useState("");

  if (!workspace.addOpen) return null;

  const addCustom = () => {
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error("bad");
      const added = workspace.addSource({ name: parsed.hostname.replace(/^www\./, ""), short: "RSS", url, ai, includeExisting, limit });
      if (!added) setError("Источник уже подключён");
    } catch {
      setError("Вставь полный адрес RSS/Atom, начиная с https://");
    }
  };

  return (
    <div className={styles.drawerBackdrop} onMouseDown={(event) => { if (event.currentTarget === event.target) workspace.setAddOpen(false); }}>
      <aside className={styles.addDrawer} role="dialog" aria-modal="true" aria-labelledby="add-source-title">
        <header><div><small>Безопасное подключение</small><h2 id="add-source-title">Добавить источник</h2></div><button type="button" aria-label="Закрыть" onClick={() => workspace.setAddOpen(false)}><X aria-hidden /></button></header>
        <div className={styles.addTabs}><button type="button" aria-pressed={mode === "catalog"} onClick={() => setMode("catalog")}>Подборка</button><button type="button" aria-pressed={mode === "url"} onClick={() => setMode("url")}>RSS-ссылка</button></div>

        {mode === "catalog" ? (
          <div className={styles.catalogList}>
            <p>Источники подобраны под тему выбранного канала.</p>
            {CATALOG.map((source) => <article key={source.name}><span>{source.short}</span><div><strong>{source.name}</strong><small>{source.url}</small></div><button type="button" onClick={() => workspace.addSource({ ...source, ai, includeExisting, limit })}>Добавить</button></article>)}
          </div>
        ) : (
          <div className={styles.urlForm}>
            <label htmlFor="prototype-rss-url">Адрес RSS или Atom</label>
            <div><Link2 aria-hidden /><input id="prototype-rss-url" value={url} onChange={(event) => { setUrl(event.target.value); setError(""); }} placeholder="https://site.ru/feed.xml" /></div>
            {error ? <p role="alert">{error}</p> : <small>Сначала проверим адрес и записи. Источник всё равно добавится на паузе.</small>}
          </div>
        )}

        <section className={styles.safeSettings}>
          <h3>Правило для нового источника</h3>
          <label><span><strong>Адаптировать под голос канала</strong><small>Факты сохраняются, меняется только подача</small></span><input type="checkbox" checked={ai} onChange={(event) => setAi(event.target.checked)} /></label>
          <label><span><strong>Взять текущие записи</strong><small>По умолчанию начинаем только с новых</small></span><input type="checkbox" checked={includeExisting} onChange={(event) => setIncludeExisting(event.target.checked)} /></label>
          <label><span><strong>Лимит на источник</strong><small>Лишние записи не переносятся на завтра</small></span><select value={limit} onChange={(event) => setLimit(Number(event.target.value))}>{[1, 2, 3, 4, 5, 6].map((value) => <option key={value} value={value}>{value} / 24ч</option>)}</select></label>
        </section>

        <footer><p><CirclePause aria-hidden />После добавления ничего не публикуется до отдельного запуска.</p>{mode === "url" && <button type="button" className={styles.primaryButton} disabled={!url.trim()} onClick={addCustom}>Проверить и добавить</button>}</footer>
      </aside>
    </div>
  );
}

function QueueList({ queue, dense = false }: { queue: QueueItem[]; dense?: boolean }) {
  if (!queue.length) return <div className={styles.emptyState}><CalendarClock aria-hidden /><strong>Очередь пуста</strong><span>Новые подходящие записи появятся после проверки.</span></div>;
  return <div className={styles.queueList} data-dense={dense || undefined}>{queue.map((item) => <article key={item.id}><time>{item.time}</time><div><small>{item.source}</small><strong>{item.title}</strong></div><span data-state={item.state}>{item.state === "scheduled" ? "В календаре" : "Черновик"}</span></article>)}</div>;
}

function DecisionList({ decisions, limit }: { decisions: Decision[]; limit?: number }) {
  return <div className={styles.decisionList}>{decisions.slice(0, limit).map((item) => <article key={item.id}><StateDot state={item.state === "created" ? "ok" : "paused"} /><time>{item.time}</time><div><small>{item.source}</small><strong>{item.title}</strong><span>{item.result}</span></div></article>)}</div>;
}

function CommandCenter({ workspace }: { workspace: Workspace }) {
  return (
    <main className={styles.commandScreen} id="main">
      <ProductHeader workspace={workspace} label="командный центр" />
      <section className={styles.commandStatus}>
        <div><span className={styles.eyebrow}><Zap aria-hidden />Автопубликация работает</span><h1>Сегодня всё<br />под контролем.</h1><p>Вмешательство нужно только для одного источника. Остальная работа уже в календаре.</p></div>
        <dl><div><dt>Активны</dt><dd>{workspace.activeSources}/{workspace.sources.length}</dd></div><div><dt>В очереди</dt><dd>{workspace.queue.length}</dd></div><div data-alert={workspace.issues > 0}><dt>Требуют внимания</dt><dd>{workspace.issues}</dd></div></dl>
      </section>
      <div className={styles.commandGrid}>
        <section className={styles.panel}><header><div><small>Управление</small><h2>Источники</h2></div><button type="button" onClick={() => workspace.setAddOpen(true)}><Plus aria-hidden />Добавить</button></header><div className={styles.sourceRows}>{workspace.sources.map((source) => <article key={source.id} className={styles.sourceRow}><div className={styles.sourceIdentity}><span>{source.short}</span><div><strong>{source.name}</strong><small><StateDot state={source.state} />{source.active ? `Проверен ${source.lastCheck}` : source.state === "error" ? "Не отвечает — остановлен" : "На паузе"}</small></div></div><SourceSettings source={source} workspace={workspace} compact /></article>)}</div></section>
        <div className={styles.commandSide}>
          <section className={styles.panel}><header><div><small>Результат</small><h2>Что выйдет</h2></div><Link href="/app/calendar">Календарь <ArrowRight aria-hidden /></Link></header><QueueList queue={workspace.queue} dense /></section>
          <section className={styles.panel}><header><div><small>Последняя проверка</small><h2>Решения</h2></div><button type="button">Весь журнал</button></header><DecisionList decisions={workspace.decisions} limit={3} /></section>
        </div>
      </div>
      <Notice text={workspace.notice} />
      <AddSourcePanel workspace={workspace} />
    </main>
  );
}

function Pipeline({ workspace }: { workspace: Workspace }) {
  const [selectedId, setSelectedId] = useState(workspace.decisions[0]?.id ?? 1);
  const [sourceFilter, setSourceFilter] = useState<number | "all">("all");
  const selected = workspace.decisions.find((item) => item.id === selectedId) ?? workspace.decisions[0];
  const created = workspace.decisions.filter((item) => item.state === "created" && (sourceFilter === "all" || item.sourceId === sourceFilter));
  const skipped = workspace.decisions.filter((item) => item.state === "skipped" && (sourceFilter === "all" || item.sourceId === sourceFilter));
  const scheduled = workspace.queue.filter((item) => sourceFilter === "all" || item.sourceId === sourceFilter);

  return (
    <main className={styles.pipelineScreen} id="main">
      <ProductHeader workspace={workspace} label="конвейер материалов" />
      <section className={styles.pipelineTools}><div><ListFilter aria-hidden /><select aria-label="Фильтр по источнику" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value === "all" ? "all" : Number(event.target.value))}><option value="all">Все источники</option>{workspace.sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></div><div className={styles.sourceChips}>{workspace.sources.map((source) => <button type="button" key={source.id} data-active={source.active || undefined} onClick={() => workspace.toggleSource(source.id)}><StateDot state={source.state} />{source.name}{source.active ? <Pause aria-hidden /> : <Play aria-hidden />}</button>)}</div></section>
      <section className={styles.pipelineBoard}>
        <div className={styles.pipelineColumn}><header><span>01</span><div><small>Допущены редактором</small><h2>Создано</h2></div><b>{created.length}</b></header><div>{created.map((item) => <button type="button" key={item.id} aria-pressed={selected?.id === item.id} onClick={() => setSelectedId(item.id)}><small>{item.time} · {item.source}</small><strong>{item.title}</strong><span><FileCheck2 aria-hidden />{item.result}</span></button>)}</div></div>
        <div className={styles.pipelineColumn}><header><span>02</span><div><small>Будущий результат</small><h2>В календаре</h2></div><b>{scheduled.length}</b></header><div>{scheduled.map((item) => <article key={item.id}><small>{item.source}</small><strong>{item.title}</strong><span><CalendarClock aria-hidden />Сегодня, {item.time}</span></article>)}</div></div>
        <div className={styles.pipelineColumn}><header><span>03</span><div><small>Не тратят лимит</small><h2>Отсеяно</h2></div><b>{skipped.length}</b></header><div>{skipped.map((item) => <button type="button" key={item.id} aria-pressed={selected?.id === item.id} onClick={() => setSelectedId(item.id)}><small>{item.time} · {item.source}</small><strong>{item.title}</strong><span><Filter aria-hidden />{item.result}</span></button>)}</div></div>
        <aside className={styles.pipelineInspector}>{selected ? <><header><small>Почему так</small><button type="button" aria-label="Закрыть карточку"><X aria-hidden /></button></header><span data-result={selected.state}>{selected.state === "created" ? <CheckCircle2 aria-hidden /> : <CirclePause aria-hidden />}{selected.state === "created" ? "Материал создан" : "Материал пропущен"}</span><h2>{selected.title}</h2><p>{selected.reason}</p><dl><div><dt>Источник</dt><dd>{selected.source}</dd></div><div><dt>Результат</dt><dd>{selected.result}</dd></div></dl><button type="button" className={styles.secondaryButton}>{selected.state === "created" ? "Открыть материал" : "Изменить правило"}<ArrowRight aria-hidden /></button></> : <div className={styles.emptyState}>Выбери карточку</div>}</aside>
      </section>
      <Notice text={workspace.notice} />
      <AddSourcePanel workspace={workspace} />
    </main>
  );
}

function SourceCockpit({ workspace }: { workspace: Workspace }) {
  const [selectedSourceId, setSelectedSourceId] = useState(workspace.sources[0]?.id ?? 1);
  const selected = workspace.sources.find((source) => source.id === selectedSourceId) ?? workspace.sources[0];
  const sourceQueue = workspace.queue.filter((item) => item.sourceId === selected?.id);
  const sourceDecisions = workspace.decisions.filter((item) => item.sourceId === selected?.id);

  return (
    <main className={styles.cockpitScreen} id="main">
      <ProductHeader workspace={workspace} label="управление источниками" />
      <section className={styles.cockpitIntro}><div><span className={styles.eyebrow}>Каждая лента — отдельное правило</span><h1>Источник под<br />полным контролем.</h1></div><p>Выбираешь ленту и сразу видишь её настройки, очередь и причины решений — без смешивания данных разных источников.</p></section>
      <section className={styles.cockpitWorkspace}>
        <aside className={styles.sourceIndex}><header><strong>Источники</strong><button type="button" onClick={() => workspace.setAddOpen(true)}><Plus aria-hidden /></button></header>{workspace.sources.map((source) => <button type="button" key={source.id} aria-pressed={source.id === selected?.id} onClick={() => setSelectedSourceId(source.id)}><span>{source.short}</span><div><strong>{source.name}</strong><small><StateDot state={source.state} />{source.active ? "Работает" : source.state === "error" ? "Ошибка" : "Пауза"}</small></div><b>{source.created}</b></button>)}</aside>
        {selected && <div className={styles.sourceDetail}>
          <header><div><span>{selected.short}</span><div><small>{selected.url}</small><h2>{selected.name}</h2></div></div><div className={styles.bigState} data-state={selected.state}><StateDot state={selected.state} /><strong>{selected.active ? "Работает" : selected.state === "error" ? "Нужна проверка" : "На паузе"}</strong><small>{selected.lastCheck}</small></div></header>
          <section className={styles.detailSettings}><div><small>Автопубликация</small><strong>{selected.active ? "Включена" : "Остановлена"}</strong><button type="button" onClick={() => workspace.toggleSource(selected.id)}>{selected.active ? <Pause aria-hidden /> : <Play aria-hidden />}{selected.active ? "Остановить" : "Запустить"}</button></div><label><small>Редактор</small><strong>Голос канала</strong><input type="checkbox" checked={selected.ai} onChange={(event) => workspace.patchSource(selected.id, { ai: event.target.checked })} /></label><label><small>Ограничение</small><strong>Постов за 24 часа</strong><select aria-label={`Лимит для ${selected.name}`} value={selected.limit} onChange={(event) => workspace.patchSource(selected.id, { limit: Number(event.target.value) })}>{[1, 2, 3, 4, 5, 6].map((value) => <option key={value} value={value}>{value}</option>)}</select></label><div><small>Текущие записи</small><strong>{selected.includeExisting ? "Можно взять" : "Не публиковать"}</strong><input type="checkbox" checked={selected.includeExisting} onChange={(event) => workspace.patchSource(selected.id, { includeExisting: event.target.checked })} /></div></section>
          <div className={styles.sourceOutcome}><section><header><div><small>Очередь источника</small><h3>Что выйдет</h3></div><b>{sourceQueue.length}</b></header><QueueList queue={sourceQueue} dense /></section><section><header><div><small>Последние записи</small><h3>Что решила Аврора</h3></div><b>{sourceDecisions.length}</b></header><DecisionList decisions={sourceDecisions} limit={4} /></section></div>
          <footer><span>При паузе ожидающие RSS-посты будут сняты с расписания.</span><button type="button" className={styles.deleteText} onClick={() => workspace.setConfirmDeleteId(selected.id)}><Trash2 aria-hidden />Удалить источник</button>{workspace.confirmDeleteId === selected.id && <div className={styles.deleteConfirm} role="alert"><span>Удалить ленту и её журнал?</span><button type="button" onClick={() => workspace.setConfirmDeleteId(null)}>Отмена</button><button type="button" onClick={() => workspace.deleteSource(selected.id)}>Удалить</button></div>}</footer>
        </div>}
      </section>
      <Notice text={workspace.notice} />
      <AddSourcePanel workspace={workspace} />
    </main>
  );
}

function FocusWorkspace({ workspace }: { workspace: Workspace }) {
  const [view, setView] = useState<"today" | "sources" | "journal">("today");
  const [journalFilter, setJournalFilter] = useState<"all" | DecisionState>("all");
  const visibleDecisions = useMemo(() => workspace.decisions.filter((item) => journalFilter === "all" || item.state === journalFilter), [journalFilter, workspace.decisions]);

  return (
    <main className={styles.focusScreen} id="main">
      <ProductHeader workspace={workspace} label="фокус-режим" />
      <nav className={styles.focusNav} aria-label="Разделы RSS"><button type="button" aria-pressed={view === "today"} onClick={() => setView("today")}><Zap aria-hidden />Сегодня<span>{workspace.queue.length}</span></button><button type="button" aria-pressed={view === "sources"} onClick={() => setView("sources")}><Rss aria-hidden />Источники<span>{workspace.sources.length}</span></button><button type="button" aria-pressed={view === "journal"} onClick={() => setView("journal")}><ListFilter aria-hidden />Журнал<span>{workspace.decisions.length}</span></button></nav>

      {view === "today" && <section className={styles.todayView}><div className={styles.todayHero}><span className={styles.eyebrow}><CheckCircle2 aria-hidden />Аврора работает</span><h1>Следующий пост<br />в 13:30.</h1><p>Два источника активны. Один требует внимания, но не мешает остальной автопубликации.</p><div><button type="button" className={styles.primaryButton} onClick={workspace.runCheck}><RefreshCw aria-hidden />Проверить сейчас</button><button type="button" className={styles.secondaryButton} onClick={() => setView("sources")}>Настроить источники</button></div></div><aside className={styles.nextCard}><small>Следующий материал</small><strong>{workspace.queue[0]?.title ?? "Очередь пуста"}</strong><span>{workspace.queue[0]?.source} · {workspace.queue[0]?.time}</span><Link href="/app/calendar">Открыть календарь <ArrowRight aria-hidden /></Link></aside><section className={styles.todayQueue}><header><h2>Дальше сегодня</h2><span>{workspace.queue.length} материала</span></header><QueueList queue={workspace.queue} /></section><section className={styles.exceptionCard}><AlertTriangle aria-hidden /><div><small>Нужно действие</small><strong>TechCrunch не отвечает со вчера</strong><p>Источник остановлен. Остальные продолжают работать.</p></div><button type="button" onClick={() => setView("sources")}>Разобраться <ArrowRight aria-hidden /></button></section></section>}

      {view === "sources" && <section className={styles.focusSources}><header><div><small>Автопубликация по каналу</small><h1>Источники</h1></div><button type="button" className={styles.primaryButton} onClick={() => workspace.setAddOpen(true)}><Plus aria-hidden />Добавить</button></header><div>{workspace.sources.map((source) => <article key={source.id}><div className={styles.sourceIdentity}><span>{source.short}</span><div><strong>{source.name}</strong><small><StateDot state={source.state} />{source.active ? `Проверен ${source.lastCheck}` : source.state === "error" ? "Не отвечает" : "На паузе"}</small></div></div><div className={styles.sourceMetrics}><span><small>Создано</small><strong>{source.created}</strong></span><span><small>Отсеяно</small><strong>{source.skipped}</strong></span></div><SourceSettings source={source} workspace={workspace} /></article>)}</div></section>}

      {view === "journal" && <section className={styles.focusJournal}><header><div><small>Последние 30 записей</small><h1>Журнал решений</h1></div><div className={styles.journalFilters}><button type="button" aria-pressed={journalFilter === "all"} onClick={() => setJournalFilter("all")}>Все</button><button type="button" aria-pressed={journalFilter === "created"} onClick={() => setJournalFilter("created")}>Созданы</button><button type="button" aria-pressed={journalFilter === "skipped"} onClick={() => setJournalFilter("skipped")}>Отсеяны</button></div></header><div className={styles.journalTable}>{visibleDecisions.map((item) => <article key={item.id}><time>{item.time}</time><div><small>{item.source}</small><strong>{item.title}</strong></div><span data-state={item.state}>{item.state === "created" ? <CheckCircle2 aria-hidden /> : <Filter aria-hidden />}{item.result}</span><p>{item.reason}</p><button type="button" aria-label="Открыть оригинал"><ExternalLink aria-hidden /></button></article>)}</div></section>}
      <Notice text={workspace.notice} />
      <AddSourcePanel workspace={workspace} />
    </main>
  );
}

export function RssVariants({ variant }: { variant: RssVariant }) {
  const workspace = useRssWorkspace();
  const screen = variant === 1 ? <CommandCenter workspace={workspace} /> : variant === 2 ? <Pipeline workspace={workspace} /> : variant === 3 ? <SourceCockpit workspace={workspace} /> : <FocusWorkspace workspace={workspace} />;
  return <div className={styles.lab}><VariantNav active={variant} />{screen}</div>;
}
