import {
  BarChart3,
  CalendarDays,
  Check,
  ChevronDown,
  FileCheck2,
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
            Юридическая практика
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
                  {index === 1 ? <i className={styles.calendarSecondPost}>Разбор</i> : null}
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
          <span><FileCheck2 />Доказательства</span>
          <b>3 из 4</b>
        </header>
        <div className={styles.proofProgress}>
          <span /><span /><span /><span />
        </div>
        <footer><span>Источник указан</span><span>Решение ожидается</span></footer>
      </article>

      <div className={styles.socialRail}>
        <span className={styles.socialTelegram}>TG</span>
        <b>Telegram после настройки</b>
      </div>
    </div>
  );
}
