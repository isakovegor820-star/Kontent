"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { BookOpenCheck, Check, FileText, Radio, UserRound, type LucideIcon } from "lucide-react";
import { V3Reveal } from "./reveal";
import styles from "./memory-archive.module.css";

type SourceId = "profile" | "materials" | "channel";

type MemorySource = {
  id: SourceId;
  number: string;
  label: string;
  kind: string;
  amount: string;
  status: string;
  cardType: string;
  headline: string;
  details: string[];
  source: string;
  use: string;
  Icon: LucideIcon;
};

const SOURCES: MemorySource[] = [
  {
    id: "profile",
    number: "01",
    label: "О себе и услугах",
    kind: "Анкета владельца",
    amount: "12 фактов",
    status: "Разобрано",
    cardType: "Факт / подтверждено",
    headline: "Работаем с предпринимателями по всей России.",
    details: [
      "Специализация — налоговые проверки и споры",
      "Не обещаем гарантированный исход дела",
    ],
    source: "Ответ владельца в анкете",
    use: "Можно использовать как конкретику в материалах",
    Icon: UserRound,
  },
  {
    id: "materials",
    number: "02",
    label: "Вопросы и кейсы",
    kind: "Вставленный текст",
    amount: "18 фактов",
    status: "Разобрано",
    cardType: "Опора / частый вопрос",
    headline: "До консультации проверяем требование, сроки и документы.",
    details: [
      "Что подготовить к первому разговору",
      "Какие детали нельзя опускать в объяснении",
    ],
    source: "Материал «Частые вопросы клиентов»",
    use: "Аврора может объяснять порядок без домыслов",
    Icon: FileText,
  },
  {
    id: "channel",
    number: "03",
    label: "Архив канала",
    kind: "Открытые публикации",
    amount: "46 примеров",
    status: "Голос считан",
    cardType: "Голос / не является фактом",
    headline: "Коротко. На «ты». Без юридического канцелярита.",
    details: [
      "Абзацы по 1–3 строки",
      "Спокойный тон без запугивания и громких обещаний",
    ],
    source: "46 прошлых публикаций канала",
    use: "Используется только как образец подачи",
    Icon: Radio,
  },
] as const;

const RULES = [
  {
    number: "01",
    title: "Факты — из опоры",
    text: "Услуги, условия и конкретика берутся только из добавленных материалов.",
  },
  {
    number: "02",
    title: "Голос — из канала",
    text: "Прошлые посты учат подаче, но не становятся доказательством фактов.",
  },
  {
    number: "03",
    title: "Нет опоры — нет выдумки",
    text: "Если подтверждения нет, Аврора пишет общо и честно, без придуманных дат и сумм.",
  },
] as const;

export function V3MemoryArchive() {
  const [active, setActive] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const reduced = useReducedMotion();
  const uid = useId();
  const source = SOURCES[active];

  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const direction =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? -1
          : 0;

    if (!direction) return;
    event.preventDefault();
    const next = (index + direction + SOURCES.length) % SOURCES.length;
    setActive(next);
    queueMicrotask(() => tabs.current[next]?.focus());
  }

  return (
    <section id="memory" aria-labelledby="memory-title" className={styles.section}>
      <div className="v3-wrap">
        <V3Reveal className={styles.intro}>
          <div>
            <p className="v3-kicker">Память канала</p>
            <h2 id="memory-title" className={styles.title}>
              Пишет не из воздуха
            </h2>
          </div>
          <div className={styles.introCopy}>
            <span>05 / База знаний</span>
            <p className="v3-body">
              У каждого канала своя опора: факты отдельно, голос отдельно. Аврора знает, где можно
              быть конкретной — и где лучше ничего не выдумывать.
            </p>
          </div>
        </V3Reveal>

        <V3Reveal delay={0.08} className={styles.archiveWrap}>
          <div className={styles.archive}>
            <header className={styles.topbar}>
              <span className={styles.systemName}>
                <i aria-hidden />
                Aurora memory / live
              </span>
              <span>Канал: «Юрист без канцелярита»</span>
              <span className={styles.topbarStatus}>30 фактов · 46 примеров голоса</span>
            </header>

            <div className={styles.workspace}>
              <div className={styles.sources}>
                <div className={styles.columnHead}>
                  <span>Входящие источники</span>
                  <strong>03</strong>
                </div>
                <div role="tablist" aria-label="Источники памяти Авроры" className={styles.sourceList}>
                  {SOURCES.map((item, index) => {
                    const selected = active === index;
                    const Icon = item.Icon;
                    return (
                      <button
                        key={item.id}
                        ref={(node) => {
                          tabs.current[index] = node;
                        }}
                        type="button"
                        role="tab"
                        id={`${uid}-tab-${item.id}`}
                        aria-controls={`${uid}-panel`}
                        aria-selected={selected}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => setActive(index)}
                        onKeyDown={(event) => moveTab(event, index)}
                        className={styles.sourceButton}
                      >
                        <span className={styles.sourceNumber}>{item.number}</span>
                        <span className={styles.sourceIcon} aria-hidden>
                          <Icon />
                        </span>
                        <span className={styles.sourceText}>
                          <strong>{item.label}</strong>
                          <small>{item.kind}</small>
                        </span>
                        <span className={styles.sourceAmount}>{item.amount}</span>
                      </button>
                    );
                  })}
                </div>
                <p className={styles.sourceNote}>
                  Текст можно вставить вручную, о бизнесе — рассказать в анкете, канал — прочитать
                  одной кнопкой.
                </p>
              </div>

              <div className={styles.cardStage}>
                <div className={styles.stageHead}>
                  <span>Карточка памяти</span>
                  <span>{source.status}</span>
                </div>
                <AnimatePresence mode="wait" initial={false}>
                  <motion.article
                    key={source.id}
                    id={`${uid}-panel`}
                    role="tabpanel"
                    aria-labelledby={`${uid}-tab-${source.id}`}
                    initial={reduced ? false : { x: 64, rotate: 1.5 }}
                    animate={{ x: 0, rotate: -0.35 }}
                    exit={reduced ? undefined : { x: -48, rotate: -1.5 }}
                    transition={{ duration: reduced ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
                    className={styles.memoryCard}
                  >
                    <header>
                      <span>{source.cardType}</span>
                      <span>№ {source.number}-024</span>
                    </header>
                    <div className={styles.cardBody}>
                      <span className={styles.cardIndex}>{source.number}</span>
                      <span className={styles.verified}>
                        <Check aria-hidden />
                        Зафиксировано
                      </span>
                      <h3>{source.headline}</h3>
                      <ul>
                        {source.details.map((detail) => (
                          <li key={detail}>{detail}</li>
                        ))}
                      </ul>
                    </div>
                    <footer>
                      <div>
                        <span>Источник</span>
                        <strong>{source.source}</strong>
                      </div>
                      <div>
                        <span>Как используется</span>
                        <strong>{source.use}</strong>
                      </div>
                    </footer>
                  </motion.article>
                </AnimatePresence>
              </div>

              <aside className={styles.rules} aria-label="Правила работы памяти">
                <div className={styles.rulesHead}>
                  <BookOpenCheck aria-hidden />
                  <span>Как думает система</span>
                </div>
                <ol>
                  {RULES.map((rule) => (
                    <li key={rule.number}>
                      <span>{rule.number}</span>
                      <div>
                        <strong>{rule.title}</strong>
                        <p>{rule.text}</p>
                      </div>
                    </li>
                  ))}
                </ol>
                <div className={styles.noSource}>
                  <span>Нет источника</span>
                  <strong>Не выдумывать</strong>
                </div>
              </aside>
            </div>

            <footer className={styles.bottomRail}>
              <span>Факты ≠ голос</span>
              <p>Конкретика получает источник. Манера речи — только образец.</p>
              <span className={styles.memoryReady}>Память готова к работе</span>
            </footer>
          </div>
        </V3Reveal>
      </div>
    </section>
  );
}
