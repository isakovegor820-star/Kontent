import { Check, Clock3, MessageSquareText, RadioTower } from "lucide-react";
import { V3Reveal } from "./reveal";
import styles from "./production-story.module.css";

const OUTCOMES = [
  {
    label: "Темы",
    title: "Не начинаешь с пустого листа",
    text: "Разведка приносит не россыпь ссылок, а понятный сигнал: что растёт, почему это сработало и что можно забрать себе.",
    result: "На входе — готовое направление",
    Icon: RadioTower,
  },
  {
    label: "Голос",
    title: "Не переписываешь ИИ с нуля",
    text: "Факты берутся из твоих материалов, а ритм и подача — из опубликованных постов. Одно не подменяет другое.",
    result: "На выходе — материал, похожий на тебя",
    Icon: MessageSquareText,
  },
  {
    label: "Выпуск",
    title: "Не держишь ноутбук открытым",
    text: "После проверки пост встаёт в расписание и выходит с сервера. Очередь можно остановить, поправить и запустить снова.",
    result: "Канал держит ритм без ручной рутины",
    Icon: Clock3,
  },
] as const;

export function V3ProductionStory() {
  return (
    <section className={styles.section} aria-labelledby="production-story-title">
      <div className={`v3-wrap ${styles.inner}`}>
        <V3Reveal className={styles.header}>
          <div>
            <div className={styles.eyebrow}>
              <p className="v3-kicker">После подключения</p>
              <span><i aria-hidden /> Контур замкнут</span>
            </div>
            <h2 id="production-story-title">Ритм появляется там, где раньше всё зависало</h2>
          </div>
          <p>
            Не ещё один генератор текстов. Аврора закрывает три разрыва между намерением вести
            канал и публикацией, которая действительно вышла.
          </p>
        </V3Reveal>

        <ol className={styles.grid} aria-label="Что меняется после подключения Авроры">
          {OUTCOMES.map((outcome, index) => (
            <li key={outcome.label} className={styles.card}>
              <V3Reveal delay={index * 0.06} className={styles.cardInner}>
                <div className={styles.cardTop}>
                  <span>{outcome.label}</span>
                  <span className={styles.iconBox}>
                    <outcome.Icon aria-hidden strokeWidth={2.4} />
                  </span>
                </div>
                <strong>{outcome.title}</strong>
                <p>{outcome.text}</p>
                <div className={styles.result}>
                  <Check aria-hidden strokeWidth={3.2} />
                  <span>{outcome.result}</span>
                </div>
              </V3Reveal>
            </li>
          ))}
        </ol>

        <V3Reveal className={styles.bottomLine}>
          <span>Ты задаёшь факты, голос и границы.</span>
          <strong>Аврора доводит материал до выпуска.</strong>
        </V3Reveal>
      </div>
    </section>
  );
}
