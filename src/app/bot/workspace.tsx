"use client";

import { AlertTriangle, ArrowUpRight, CalendarDays, CheckCircle2, LoaderCircle, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import styles from "./workspace.module.css";

type Overview = {
  project: string;
  timezone: string;
  role: string;
  scheduled: number;
  failed: number;
  reconnect: number;
  reviews: number;
  publishedWeek: number;
  upcoming: Array<{ id: number; text: string; scheduledAt: string; channel: string }>;
};

const DEVELOPMENT_PREVIEW: Overview = {
  project: "Аврора",
  timezone: "Europe/Moscow",
  role: "owner",
  scheduled: 6,
  failed: 1,
  reconnect: 0,
  reviews: 2,
  publishedWeek: 8,
  upcoming: [
    { id: 1, text: "Как превратить одну сильную идею в неделю контента без повторов", scheduledAt: "2026-08-15T07:00:00.000Z", channel: "Аврора · продукт" },
    { id: 2, text: "Разбор: почему короткий хук удержал внимание аудитории", scheduledAt: "2026-08-15T14:30:00.000Z", channel: "Аврора · медиа" },
  ],
};

declare global {
  interface Window {
    Telegram?: { WebApp?: { initData?: string; ready(): void; expand(): void; openLink(url: string): void } };
  }
}

export function BotWorkspace() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const webApp = window.Telegram?.WebApp;
    webApp?.ready();
    webApp?.expand();
    async function load() {
      if (process.env.NODE_ENV !== "production" && new URLSearchParams(window.location.search).has("preview")) {
        await Promise.resolve();
        if (active) setOverview(DEVELOPMENT_PREVIEW);
        return;
      }
      const initData = webApp?.initData || "";
      if (!initData) throw new Error("open_in_bot");
      const response = await fetch("/api/bot/miniapp/overview", { headers: { "x-telegram-init-data": initData } });
        const body = await response.json();
        if (!response.ok || !body?.ok) throw new Error(body?.error || "overview_failed");
      if (active) setOverview(body.overview);
    }
    void load().catch((loadError) => {
      if (!active) return;
      setError(loadError instanceof Error && loadError.message === "open_in_bot"
        ? "Открой этот кабинет кнопкой внутри бота Авроры — так Telegram безопасно подтвердит аккаунт."
        : "Не удалось загрузить кабинет. Закрой его и открой ещё раз из меню бота.");
    });
    return () => { active = false; };
  }, []);

  if (error) return <main id="main" className={styles.shell}><section className={styles.state} role="alert"><AlertTriangle aria-hidden="true" /><h1>Кабинет не открыт</h1><p>{error}</p></section></main>;
  if (!overview) return <main id="main" className={styles.shell}><section className={styles.state} aria-live="polite"><LoaderCircle className={styles.spinner} aria-hidden="true" /><h1>Загружаю Аврору</h1><p>Проверяю проект и актуальные данные.</p></section></main>;

  const attention = overview.failed + overview.reconnect + overview.reviews;
  const openPlatform = (path: string) => window.Telegram?.WebApp?.openLink(`${window.location.origin}${path}`);
  return (
    <main id="main" className={styles.shell}>
      <header className={styles.header}>
        <span className={styles.mark} aria-hidden="true"><Sparkles /></span>
        <div><p className={styles.eyebrow}>Аврора в Telegram</p><h1>{overview.project}</h1></div>
      </header>

      <section className={styles.hero} aria-labelledby="today-title">
        <div><p className={styles.eyebrow}>Сегодня</p><h2 id="today-title">Контент под контролем</h2></div>
        <CheckCircle2 aria-hidden="true" />
        <div className={styles.metrics}>
          <article><strong>{overview.scheduled}</strong><span>в очереди</span></article>
          <article><strong>{overview.publishedWeek}</strong><span>вышло за неделю</span></article>
          <article className={attention ? styles.attention : undefined}><strong>{attention}</strong><span>требует внимания</span></article>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="attention-title">
        <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>Решения</p><h2 id="attention-title">Что проверить</h2></div><AlertTriangle aria-hidden="true" /></div>
        {attention ? <div className={styles.list}>
          {overview.reviews > 0 && <button type="button" onClick={() => openPlatform("/app/studio")}><span>Согласование</span><b>{overview.reviews}</b><ArrowUpRight aria-hidden="true" /></button>}
          {overview.failed > 0 && <button type="button" onClick={() => openPlatform("/app/calendar")}><span>Ошибки публикаций</span><b>{overview.failed}</b><ArrowUpRight aria-hidden="true" /></button>}
          {overview.reconnect > 0 && <button type="button" onClick={() => openPlatform("/app/settings")}><span>Переподключить каналы</span><b>{overview.reconnect}</b><ArrowUpRight aria-hidden="true" /></button>}
        </div> : <p className={styles.empty}>Подтверждённых проблем нет. Можно спокойно готовить следующий пост.</p>}
      </section>

      <section className={styles.section} aria-labelledby="calendar-title">
        <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>Ближайшее</p><h2 id="calendar-title">Календарь</h2></div><CalendarDays aria-hidden="true" /></div>
        {overview.upcoming.length ? <ol className={styles.schedule}>{overview.upcoming.map((item) => <li key={item.id}><time dateTime={item.scheduledAt}>{new Date(item.scheduledAt).toLocaleString("ru-RU", { timeZone: overview.timezone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</time><div><strong>{item.channel}</strong><p>{item.text}</p></div></li>)}</ol> : <p className={styles.empty}>В очереди пока ничего нет.</p>}
        <button className={styles.primary} type="button" onClick={() => openPlatform("/app/calendar")}>Открыть полный календарь <ArrowUpRight aria-hidden="true" /></button>
      </section>
    </main>
  );
}
