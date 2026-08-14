import {
  BarChart3,
  CalendarDays,
  Check,
  ChevronDown,
  FileText,
  LayoutDashboard,
  MessageCircle,
  Plus,
  Send,
  Settings2,
  Sparkles,
  UsersRound,
} from "lucide-react";
import { Logo } from "@/components/brand";
import styles from "./reference-landing.module.css";

const days = [
  { day: "Пн", date: "12", status: "Готово", tone: "blue" },
  { day: "Вт", date: "13", status: "10:00", tone: "violet" },
  { day: "Ср", date: "14", status: "Пауза", tone: "empty" },
  { day: "Чт", date: "15", status: "18:30", tone: "cyan" },
  { day: "Пт", date: "16", status: "Идея", tone: "orange" },
] as const;

const navIcons = [LayoutDashboard, CalendarDays, FileText, MessageCircle, BarChart3, UsersRound];

export function HeroProductScene() {
  return (
    <div className={styles.productScene} aria-hidden="true">
      <span className={styles.sceneAmbientOne} />
      <span className={styles.sceneAmbientTwo} />

      <div className={styles.productWindow}>
        <header className={styles.productTopbar}>
          <span className={styles.productMiniBrand}>
            <Logo size={25} decorative />
          </span>
          <span className={styles.productProject}>
            Кофе и код
            <ChevronDown />
          </span>
          <span className={styles.productTeam}>
            <i>МК</i>
            <i>АС</i>
            <b>+2</b>
          </span>
        </header>

        <div className={styles.productBody}>
          <aside className={styles.productSidebar}>
            {navIcons.map((Icon, index) => (
              <span className={index === 1 ? styles.productNavActive : undefined} key={index}>
                <Icon />
              </span>
            ))}
            <span className={styles.productNavSettings}><Settings2 /></span>
          </aside>

          <section className={styles.calendarPanel}>
            <header className={styles.calendarHeader}>
              <div>
                <small>Контент-план</small>
                <strong>12–18 августа</strong>
              </div>
              <span><Plus />Новый пост</span>
            </header>

            <div className={styles.calendarDays}>
              {days.map((item, index) => (
                <article className={styles.calendarDay} key={item.date}>
                  <header>
                    <span>{item.day}</span>
                    <b>{item.date}</b>
                  </header>
                  <div className={`${styles.calendarPost} ${styles[`calendarPost${item.tone}`]}`}>
                    {index === 0 ? <Check /> : index === 2 ? <Plus /> : <Sparkles />}
                    <span>{item.status}</span>
                  </div>
                  {index === 1 ? <i className={styles.calendarSecondPost}>Reels</i> : null}
                </article>
              ))}
            </div>

            <footer className={styles.calendarFooter}>
              <span><i />5 публикаций</span>
              <span><i />2 на согласовании</span>
              <b>Неделя заполнена на 71%</b>
            </footer>
          </section>
        </div>
      </div>

      <article className={styles.approvalCard}>
        <span className={styles.approvalIcon}><Check /></span>
        <div>
          <small>Следующая публикация</small>
          <strong>Пост согласован</strong>
          <span>Сегодня · 10:00</span>
        </div>
        <span className={styles.approvalSend}><Send /></span>
      </article>

      <article className={styles.metricCard}>
        <header>
          <span><BarChart3 />Охват за неделю</span>
          <b>+28%</b>
        </header>
        <svg viewBox="0 0 220 64" role="presentation">
          <defs>
            <linearGradient id="hero-metric-fill" x1="0" y1="0" x2="0" y2="1">
              <stop stopColor="#2563ff" stopOpacity=".2" />
              <stop offset="1" stopColor="#2563ff" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path className={styles.metricFill} d="M2 58 C28 54 34 38 55 42 S84 20 108 28 137 45 160 25 193 24 218 8 V64 H2Z" />
          <path className={styles.metricLine} d="M2 58 C28 54 34 38 55 42 S84 20 108 28 137 45 160 25 193 24 218 8" />
        </svg>
        <footer><span>12 авг.</span><span>Сегодня</span></footer>
      </article>

      <div className={styles.socialRail}>
        <span className={styles.socialInstagram}>IG</span>
        <span className={styles.socialVk}>VK</span>
        <span className={styles.socialTelegram}>TG</span>
        <span className={styles.socialYoutube}>YT</span>
        <b>4 канала подключено</b>
      </div>
    </div>
  );
}
