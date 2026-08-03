"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { ShieldCheck, Wand2 } from "lucide-react";
import styles from "./quality-verdict.module.css";

const ISSUES = [
  "Обещание результата",
  "Цифра без источника",
  "Кликбейт",
  "Стоп-фраза",
  "Перегруз эмодзи",
] as const;

const CHECKS = [
  "Источник найден",
  "Обещаний нет",
  "Тон совпадает",
  "Стоп-фраз нет",
  "CTA уместен",
] as const;

const EASE = [0.22, 1, 0.36, 1] as const;

export function V3QualityVerdict({ id = "quality" }: { id?: string }) {
  const [passed, setPassed] = useState(false);
  const titleId = `${id}-title`;

  return (
    <section id={id} className={styles.section} data-passed={passed} aria-labelledby={titleId}>
      <div className={styles.wrap}>
        <div className={styles.eyebrow}><i aria-hidden />Контроль качества</div>

        <header className={styles.intro}>
          <h2 id={titleId}>В канал проходит<br />не каждый текст</h2>
          <div className={styles.introCopy}>
            <span>Проверка до выпуска</span>
            <p>Аврора проверяет факты, тон, структуру и правила конкретного канала — до постановки материала в расписание.</p>
          </div>
        </header>

        <button
          type="button"
          className={styles.stage}
          onClick={() => setPassed((value) => !value)}
          aria-pressed={passed}
          aria-label={passed ? "Материал получил 92 балла и допущен к выпуску" : "Материал получил 61 балл, выпуск остановлен"}
        >
          <div className={styles.kicker}>
            <span>Материал 0184</span>
            <b>{passed ? "Допущен к выпуску" : "Выпуск остановлен"}</b>
          </div>

          <div className={styles.score} aria-live="polite">
            <motion.span
              key={passed ? "92" : "61"}
              initial={{ rotate: -5, y: 70, opacity: 0 }}
              animate={{ rotate: 0, y: 0, opacity: 1 }}
              transition={{ duration: 0.3, ease: EASE }}
            >
              {passed ? "92" : "61"}
            </motion.span>
            <small>/100</small>
          </div>

          <motion.strong animate={{ y: passed ? -8 : 8, rotate: passed ? -2 : 1 }}>
            {passed ? "Можно выпускать" : "Нужно исправить"}
          </motion.strong>
        </button>

        <div className={styles.reasons} aria-label={passed ? "Пройденные проверки" : "Причины остановки"}>
          {(passed ? CHECKS : ISSUES).map((item, index) => (
            <motion.span
              key={item}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.045 }}
            >
              {item}
            </motion.span>
          ))}
        </div>

        <footer className={styles.footer}>
          <p><ShieldCheck aria-hidden /> Материал не попадёт в расписание, пока не пройдёт порог 85.</p>
          <button type="button" onClick={() => setPassed((value) => !value)}>
            {passed ? "Показать исходник" : "Исправить по стандарту"}
            <Wand2 aria-hidden />
          </button>
        </footer>
      </div>
    </section>
  );
}
