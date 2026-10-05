import type { CSSProperties } from "react";
import { Check } from "lucide-react";
import styles from "./bento.module.css";
import { STEPS } from "./content";

/**
 * «Как это работает»: четыре шага от идеи до согласованной публикации.
 *
 * Шаги — плитки одного размера (`s3`) и одного устройства: номер, заголовок,
 * пояснение и результат. Тон приходит из данных, а не назначается по месту: цвет
 * здесь означает этап, и он не должен разъезжаться с текстом при правках.
 *
 * Результат шага — обещание, которое проверяет тест главной, поэтому он остаётся
 * одним текстовым узлом рядом с галочкой, а не собирается из отдельных слов.
 */
export function Steps() {
  return (
    <section className={`${styles.wrap} ${styles.sec}`} id="how" aria-labelledby="how-title">
      <div className={`${styles.secHead} ${styles.reveal}`}>
        <span className={styles.pill}>
          <i aria-hidden="true" />
          Как это работает
        </span>
        <h2 id="how-title">От идеи до согласованной публикации</h2>
        <p>Четыре шага сохраняют смысл, источники и ответственность за финальную версию.</p>
      </div>

      {/* Ступень лестницы: --i сдвигает вход каждой плитки внутри `.stagger`. */}
      <div className={`${styles.bento} ${styles.stagger}`}>
        {STEPS.map((step, index) => (
          <article
            className={`${styles.tile} ${styles[step.tone]} ${styles.s3} ${styles.step}`}
            data-step={step.index}
            key={step.index}
            style={{ "--i": index } as CSSProperties}
          >
            <div className={styles.num}>{step.index}</div>
            <h3>{step.title}</h3>
            <p>{step.text}</p>
            {/* `.res` прижимает результат к низу плитки: у шагов разной длины
                подписи остаются на одной линии. */}
            <span className={styles.res}>
              <Check aria-hidden="true" strokeWidth={2.2} />
              {step.result}
            </span>
          </article>
        ))}
      </div>
    </section>
  );
}
