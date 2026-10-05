import type { CSSProperties } from "react";
import { FEATURES } from "./content";
import styles from "./bento.module.css";

/**
 * Возможности: шесть плиток рабочего контура.
 *
 * Тон каждой плитки приходит из данных (`feature.tone`), а не подставляется по месту:
 * цвет здесь — часть смысла («действие» — градиент, «состояние» — пастель), и при
 * правке списка он не должен разъезжаться с содержанием.
 *
 * Ступень лестницы (`--i`) задаётся по индексу: плитки одной секции поднимаются по
 * очереди, а не все сразу — сама анимация уже описана в `.stagger`.
 */
export function Features() {
  return (
    <section
      className={`${styles.wrap} ${styles.sec}`}
      id="features"
      aria-labelledby="features-title"
    >
      <div className={`${styles.secHead} ${styles.reveal}`}>
        <span className={styles.pill}>
          <i aria-hidden="true" />
          Что умеет Аврора
        </span>
        <h2 id="features-title">Рабочий контур для юридической редакции</h2>
        <p>От темы и доказательств до согласованной версии и контролируемой публикации.</p>
      </div>

      <div className={`${styles.bento} ${styles.stagger}`}>
        {FEATURES.map((feature, index) => {
          const Icon = feature.icon;
          return (
            <article
              className={`${styles.tile} ${styles.feat} ${styles[feature.tone]} ${styles.s4}`}
              data-feature={feature.tone}
              key={feature.title}
              style={{ "--i": index } as CSSProperties}
            >
              <div className={styles.ico}>
                <Icon aria-hidden="true" strokeWidth={2.2} />
              </div>
              <h3>{feature.title}</h3>
              <p>{feature.text}</p>
            </article>
          );
        })}
      </div>
    </section>
  );
}
