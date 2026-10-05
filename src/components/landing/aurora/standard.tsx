import type { CSSProperties } from "react";
import { Check } from "lucide-react";
import styles from "./bento.module.css";
import { STANDARD_RULES } from "./content";

/**
 * «Наш стандарт»: шесть рамок, по которым выходит каждый материал.
 *
 * Секция идёт после каналов публикации и до статуса контуров: сначала обещание
 * процесса, затем — чем оно ограничено. Тон, размер, иконка и крупный знак
 * приходят из `STANDARD_RULES`: разметка не решает за данные, а только показывает.
 */
export function Standard() {
  return (
    <section
      className={`${styles.wrap} ${styles.sec}`}
      id="standard"
      aria-labelledby="standard-title"
    >
      <div className={`${styles.secHead} ${styles.reveal}`}>
        <span className={styles.pill}>
          <i aria-hidden="true" />
          Наш стандарт
        </span>
        <h2 id="standard-title">Правила, по которым выходит каждый материал</h2>
        <p>
          Это не рекламные обещания, а рамки, которые действуют для каждого материала — от
          черновика до публикации. Мы не оцениваем другие сервисы: только то, за что отвечаем сами.
        </p>
      </div>

      {/* `--i` задаёт ступень лестницы: плитки поднимаются по очереди, а не разом. */}
      <div className={`${styles.bento} ${styles.stagger}`}>
        {STANDARD_RULES.map((rule, index) => {
          const Icon = rule.icon;
          const span = styles[`s${rule.span}` as keyof typeof styles];
          return (
            <article
              className={`${styles.tile} ${styles[rule.tone]} ${span}`}
              data-rule={rule.id}
              key={rule.id}
              style={{ "--i": index } as CSSProperties}
            >
              {/* Крупный знак заменяет иконку: у плитки-печати нет предметного рисунка. */}
              {rule.big ? (
                <div className={styles.big} aria-hidden="true">
                  {rule.big}
                </div>
              ) : Icon ? (
                <div className={styles.ico}>
                  <Icon aria-hidden="true" strokeWidth={2.2} />
                </div>
              ) : null}

              <h3>{rule.title}</h3>
              {rule.text ? <p>{rule.text}</p> : null}

              {rule.checks ? (
                <ul className={styles.check}>
                  {rule.checks.map((item) => (
                    <li key={item}>
                      <Check aria-hidden="true" strokeWidth={2.2} />
                      {item}
                    </li>
                  ))}
                </ul>
              ) : null}

              {rule.bigLabel ? <div className={styles.bigLabel}>{rule.bigLabel}</div> : null}
              {rule.tag ? <span className={styles.tag}>{rule.tag}</span> : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
