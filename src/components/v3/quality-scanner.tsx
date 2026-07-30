"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AlertTriangle, Check, RefreshCw, ScanLine, ShieldCheck, Wand2 } from "lucide-react";
import { V3Reveal } from "./reveal";
import styles from "./quality-scanner.module.css";

type Phase = "idle" | "scanning" | "blocked" | "fixing" | "passed";
type Preset = "expert" | "legal" | "custom";

const PRESETS: Array<{ id: Preset; label: string; rules: string[] }> = [
  {
    id: "expert",
    label: "Экспертный",
    rules: ["Без кликбейта", "Факты без выдумок", "Продажи ≤ 20%", "До 3 эмодзи"],
  },
  {
    id: "legal",
    label: "Юридический",
    rules: ["Факты с источниками", "Обращение на «вы»", "Дисклеймер обязателен", "Без гарантий"],
  },
  {
    id: "custom",
    label: "Свой стандарт",
    rules: ["Свои стоп-фразы", "Запрещённые темы", "Своя длина", "Своя частота CTA"],
  },
];

const BLOCKERS = [
  { code: "01", title: "Обещание результата", note: "«гарантированно» запрещено стандартом" },
  { code: "02", title: "Цифра без источника", note: "97% нельзя подтвердить" },
  { code: "03", title: "Кликбейт", note: "три восклицательных знака подряд" },
  { code: "04", title: "Стоп-фраза", note: "«уникальная возможность»" },
  { code: "05", title: "Перегруз эмодзи", note: "разрешено максимум три" },
] as const;

const PASSED = [
  "Хук короче 80 знаков",
  "Непроверенных фактов нет",
  "Тон соответствует каналу",
  "Продажный лимит не превышен",
  "Стоп-фраз и стоп-тем нет",
] as const;

const CHECKS = [
  "Тон",
  "Факты",
  "Источники",
  "Хук",
  "Длина",
  "Стоп-темы",
  "Обращение",
  "CTA",
  "Эмодзи",
  "Дисклеймер",
  "Структура",
] as const;

function BadDraft({ flagged }: { flagged: boolean }) {
  const issueClass = flagged ? styles.violation : undefined;
  return (
    <p>
      Этот способ <mark className={issueClass}>ГАРАНТИРОВАННО</mark> увеличит продажи на{" "}
      <mark className={issueClass}>97%</mark>
      <mark className={issueClass}>!!!</mark> <mark className={issueClass}>Уникальная возможность</mark>
      {" — "}успейте прямо сейчас <mark className={issueClass}>🔥🔥🔥🔥🔥</mark>
    </p>
  );
}

function CleanDraft() {
  return (
    <p>
      Три изменения в карточке товара, которые стоит проверить на своей аудитории. Начни с первого
      экрана: убери общие обещания и покажи конкретный результат продукта.
    </p>
  );
}

export function V3QualityScanner() {
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState<Phase>("idle");
  const [preset, setPreset] = useState<Preset>("expert");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const activeTimers = timers.current;
    return () => activeTimers.forEach(clearTimeout);
  }, []);

  function clearTimers() {
    timers.current.forEach(clearTimeout);
    timers.current.length = 0;
  }

  function choosePreset(next: Preset) {
    clearTimers();
    setPreset(next);
    setPhase("idle");
  }

  function scan() {
    clearTimers();
    if (reduce) {
      setPhase("blocked");
      return;
    }
    setPhase("scanning");
    timers.current.push(setTimeout(() => setPhase("blocked"), 1100));
  }

  function fix() {
    clearTimers();
    if (reduce) {
      setPhase("passed");
      return;
    }
    setPhase("fixing");
    timers.current.push(setTimeout(() => setPhase("passed"), 1150));
  }

  function reset() {
    clearTimers();
    setPhase("idle");
  }

  const busy = phase === "scanning" || phase === "fixing";
  const blocked = phase === "blocked";
  const passed = phase === "passed";
  const activePreset = PRESETS.find((item) => item.id === preset) ?? PRESETS[0];
  const status = {
    idle: "Ждёт материал",
    scanning: "Идёт сканирование",
    blocked: "Выпуск остановлен",
    fixing: "Исправляет по стандарту",
    passed: "Допущен к выпуску",
  }[phase];

  return (
    <section id="quality" aria-labelledby="quality-title" className={styles.section}>
      <div className="v3-wrap">
        <V3Reveal className={styles.intro}>
          <div>
            <p className="v3-kicker">Контроль качества</p>
            <h2 id="quality-title" className={styles.title}>
              В канал проходит не каждый текст
            </h2>
          </div>
          <div className={styles.introCopy}>
            <span>04 / Редакционный рентген</span>
            <p className="v3-body">
              Аврора проверяет не только смысл: факты, тон, структуру, стоп-фразы и правила
              конкретного канала — до постановки в расписание.
            </p>
          </div>
        </V3Reveal>

        <V3Reveal delay={0.08} className={styles.machineWrap}>
          <div className={styles.machine}>
            <div className={styles.topbar}>
              <span className={styles.live}>
                <i aria-hidden />
                Redscan / 01
              </span>
              <div className={styles.presets} aria-label="Редакционный стандарт">
                {PRESETS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={preset === item.id}
                    onClick={() => choosePreset(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <span className={styles.machineStatus}>{status}</span>
            </div>

            <div className={styles.workspace}>
              <div className={styles.chamber}>
                <div className={styles.chamberHead}>
                  <span>Материал 0184</span>
                  <span>{activePreset.label} стандарт</span>
                </div>

                <div className={styles.paperSlot}>
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.article
                      key={passed ? "clean" : "draft"}
                      initial={reduce ? false : { x: 58 }}
                      animate={{ x: 0 }}
                      exit={reduce ? undefined : { x: -58 }}
                      transition={{ duration: 0.18 }}
                      className={`${styles.paper} ${passed ? styles.paperPassed : ""}`}
                    >
                      <header>
                        <span>Черновик / 0184</span>
                        <span>Канал «Маркетинг без шума»</span>
                      </header>
                      <div className={styles.paperBody}>
                        <span className={styles.paperIndex}>{passed ? "02" : "01"}</span>
                        {passed ? <CleanDraft /> : <BadDraft flagged={blocked} />}
                      </div>
                      <footer>
                        <span>{passed ? "Исправлено по стандарту" : "Версия от ИИ"}</span>
                        <span>{passed ? "1 126 знаков" : "164 знака"}</span>
                      </footer>
                      {busy && <span className={styles.scanBeam} aria-hidden />}
                    </motion.article>
                  </AnimatePresence>
                </div>

                <div className={styles.controls}>
                  {phase === "idle" && (
                    <button type="button" onClick={scan} className="v3-btn v3-btn--ink">
                      Проверить материал
                      <ScanLine className="h-4 w-4" strokeWidth={2.7} aria-hidden />
                    </button>
                  )}
                  {busy && (
                    <button type="button" disabled className="v3-btn v3-btn--ink">
                      {phase === "scanning" ? "Сканирую…" : "Исправляю…"}
                      <RefreshCw className={`${styles.spin} h-4 w-4`} strokeWidth={2.7} aria-hidden />
                    </button>
                  )}
                  {blocked && (
                    <button type="button" onClick={fix} className="v3-btn v3-btn--ink">
                      Исправить по стандарту
                      <Wand2 className="h-4 w-4" strokeWidth={2.7} aria-hidden />
                    </button>
                  )}
                  {passed && (
                    <button type="button" onClick={reset} className="v3-btn v3-btn--ink">
                      Проверить снова
                      <RefreshCw className="h-4 w-4" strokeWidth={2.7} aria-hidden />
                    </button>
                  )}
                  <p>
                    Порог выпуска: <strong>85 / 100</strong>
                  </p>
                </div>
              </div>

              <AnimatePresence mode="wait" initial={false}>
                <motion.aside
                  key={blocked ? "blocked" : passed ? "passed" : busy ? "busy" : "idle"}
                  initial={reduce ? false : { opacity: 0, x: 42 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={reduce ? undefined : { opacity: 0, x: -28 }}
                  transition={{ duration: 0.18 }}
                  className={`${styles.verdict} ${blocked ? styles.verdictBlocked : ""} ${passed ? styles.verdictPassed : ""}`}
                  aria-live="polite"
                >
                  <div className={styles.verdictHead}>
                    <span>Вердикт редакции</span>
                    {passed ? (
                      <ShieldCheck aria-hidden />
                    ) : blocked ? (
                      <AlertTriangle aria-hidden />
                    ) : busy ? (
                      <RefreshCw className={styles.spin} aria-hidden />
                    ) : (
                      <ScanLine aria-hidden />
                    )}
                  </div>

                  {!blocked && !passed ? (
                    <div className={styles.verdictPlaceholder}>
                      <span className={styles.placeholderIcon}>
                        {busy ? (
                          <RefreshCw className={styles.spin} aria-hidden />
                        ) : (
                          <ScanLine aria-hidden />
                        )}
                      </span>
                      <strong>{busy ? status : "Здесь появится результат"}</strong>
                      <p>
                        {busy
                          ? "Сверяю материал с правилами выбранного стандарта."
                          : "Нажми «Проверить материал» — покажем оценку и каждое нарушение."}
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className={styles.score}>
                        <strong>{passed ? "92" : "61"}</strong>
                        <span>/ 100</span>
                      </div>

                      <div className={styles.stamp}>{passed ? "Допущен" : "Остановлен"}</div>

                      <div className={styles.report}>
                        {blocked && (
                          <ol>
                            {BLOCKERS.map((issue) => (
                              <li key={issue.code}>
                                <span>{issue.code}</span>
                                <p>
                                  <strong>{issue.title}</strong>
                                  <small>{issue.note}</small>
                                </p>
                              </li>
                            ))}
                          </ol>
                        )}

                        {passed && (
                          <ul>
                            {PASSED.map((item) => (
                              <li key={item}>
                                <span>
                                  <Check aria-hidden />
                                </span>
                                {item}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </>
                  )}
                </motion.aside>
              </AnimatePresence>
            </div>

            <div className={styles.rules}>
              <span>Стандарт: {activePreset.label}</span>
              <div>
                {activePreset.rules.map((rule) => (
                  <b key={rule}>{rule}</b>
                ))}
              </div>
            </div>

            <div className={styles.ticker} aria-label="Что проверяет редакционный стандарт">
              {[...CHECKS, ...CHECKS].map((item, index) => (
                <span key={`${item}-${index}`}>
                  {item}
                  <i aria-hidden />
                </span>
              ))}
            </div>
          </div>
        </V3Reveal>

        <V3Reveal delay={0.1} className={styles.promise}>
          <ShieldCheck aria-hidden />
          <p>
            Если материал не проходит твой стандарт, Аврора не ставит его в расписание. Сначала
            исправляет — или показывает, что именно остановило выпуск.
          </p>
        </V3Reveal>
      </div>
    </section>
  );
}
