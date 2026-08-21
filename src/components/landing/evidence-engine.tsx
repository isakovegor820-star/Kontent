"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowRight,
  BookOpenCheck,
  Check,
  FileSearch,
  Radar,
  ScanSearch,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import styles from "./reference-landing.module.css";

type Demo = {
  id: "expert" | "estate" | "education";
  label: string;
  source: string;
  topic: string;
  views: string;
  baseline: string;
  lift: string;
  mechanism: string;
  angle: string;
  headline: string;
  excerpt: string;
  facts: string;
};

const DEMOS: Demo[] = [
  {
    id: "expert",
    label: "Экспертный бизнес",
    source: "@praktika_pro",
    topic: "Почему обещание результата разрушает доверие ещё до первой консультации",
    views: "18,4 тыс.",
    baseline: "6,7 тыс.",
    lift: "×2,7",
    mechanism: "Конкретный риск + три узнаваемые формулировки",
    angle: "Не пересказывать чужой пост, а дать редактору проверочный список до публикации",
    headline: "5 формулировок, которые звучат убедительно — и подрывают доверие",
    excerpt:
      "Сильный текст не обещает невозможного. Он показывает условия, ограничения и следующий шаг — без давления на читателя.",
    facts: "3 утверждения привязаны к источникам",
  },
  {
    id: "estate",
    label: "Недвижимость",
    source: "@novostroy_signal",
    topic: "Скрытые расходы после получения ключей от новостройки",
    views: "42,1 тыс.",
    baseline: "16,8 тыс.",
    lift: "×2,5",
    mechanism: "Разрыв ожиданий + сумма + короткий чек-лист",
    angle: "Собрать калькулятор первого месяца вместо очередного списка расходов",
    headline: "Ключи получили. А бюджет на первый месяц посчитали?",
    excerpt:
      "Приёмка — не последняя статья расходов. Заранее заложите три суммы: коммунальные авансы, базовый ремонт и обязательные работы по квартире.",
    facts: "4 цифры отмечены для проверки",
  },
  {
    id: "education",
    label: "Образование",
    source: "@learn_without_cram",
    topic: "Почему новые слова забываются через два дня",
    views: "31,6 тыс.",
    baseline: "10,2 тыс.",
    lift: "×3,1",
    mechanism: "Знакомая боль + один опыт на 7 дней",
    angle: "Дать готовый недельный протокол вместо абстрактного совета повторять чаще",
    headline: "Не учите слово семь раз. Встретьте его в семи ситуациях",
    excerpt:
      "Сегодня — услышать, завтра — написать, затем — использовать в вопросе. Семь разных контактов дают памяти больше опор, чем один длинный список.",
    facts: "Методика и формулировки требуют одобрения",
  },
];

export function EvidenceEngine() {
  const [activeId, setActiveId] = useState<Demo["id"]>("expert");
  const reduceMotion = useReducedMotion();
  const active = DEMOS.find((demo) => demo.id === activeId) ?? DEMOS[0];

  return (
    <section className={styles.evidenceEngine} aria-labelledby="evidence-engine-title">
      <div className={styles.engineTopbar}>
        <h2 className={styles.engineLive} id="evidence-engine-title">
          <i aria-hidden="true" />
          Разбор сигнала
        </h2>
        <span className={styles.engineDemoLabel}>Демо-данные</span>
      </div>

      <div className={styles.engineNiches} role="group" aria-label="Выберите пример ниши">
        {DEMOS.map((demo) => (
          <button
            type="button"
            key={demo.id}
            aria-pressed={demo.id === activeId}
            onClick={() => setActiveId(demo.id)}
          >
            {demo.label}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={active.id}
          className={styles.engineBody}
          initial={reduceMotion ? false : { opacity: 0, scale: 0.985 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.985 }}
          transition={{ type: "spring", duration: 0.3, bounce: 0 }}
        >
          <div className={styles.engineTrail}>
            <article className={styles.engineSignalCard}>
              <div className={styles.engineStepLabel}>
                <span>01</span>
                <Radar aria-hidden="true" />
                Сигнал
              </div>
              <div className={styles.engineSourceRow}>
                <strong>{active.source}</strong>
                <span><ShieldCheck aria-hidden="true" />Источник проверен</span>
              </div>
              <p>{active.topic}</p>
              <dl className={styles.engineMetrics}>
                <div><dt>Просмотры</dt><dd>{active.views}</dd></div>
                <div><dt>Норма канала</dt><dd>{active.baseline}</dd></div>
                <div className={styles.engineLift}><dt>Выше нормы</dt><dd>{active.lift}</dd></div>
              </dl>
            </article>

            <div className={styles.engineConnector} aria-hidden="true"><ArrowRight /></div>

            <article className={styles.engineReasonCard}>
              <div className={styles.engineStepLabel}>
                <span>02</span>
                <ScanSearch aria-hidden="true" />
                Почему сработало
              </div>
              <strong>{active.mechanism}</strong>
              <div className={styles.engineAngle}>
                <Sparkles aria-hidden="true" />
                <span><small>Новый угол для вашего канала</small>{active.angle}</span>
              </div>
            </article>
          </div>

          <article className={styles.engineDraft}>
            <div className={styles.engineDraftHeader}>
              <div>
                <span className={styles.engineStepLabel}>
                  <span>03</span>
                  <FileSearch aria-hidden="true" />
                  Готовый материал
                </span>
                <strong>Черновик в вашем стиле</strong>
              </div>
              <span className={styles.engineReady}><Check aria-hidden="true" />Готов к проверке</span>
            </div>

            <div className={styles.enginePost}>
              <span className={styles.enginePostChannel}>Ваш Telegram-канал</span>
              <h3>{active.headline}</h3>
              <p>{active.excerpt}</p>
            </div>

            <ul className={styles.engineChecks}>
              <li><BookOpenCheck aria-hidden="true" /><span><strong>Доказательства</strong>{active.facts}</span></li>
              <li><Sparkles aria-hidden="true" /><span><strong>Оригинальность</strong>Сравнение с 30 последними постами включено</span></li>
              <li><ShieldCheck aria-hidden="true" /><span><strong>Контроль</strong>Без одобрения материал не публикуется</span></li>
            </ul>
          </article>
        </motion.div>
      </AnimatePresence>

      <p className="sr-only" aria-live="polite">
        Выбран пример «{active.label}». Сигнал {active.lift} к норме канала, черновик готов к проверке.
      </p>
    </section>
  );
}
