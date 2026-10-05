import type { CSSProperties } from "react";
import styles from "./bento.module.css";
import { INTEGRATIONS } from "./content";

/**
 * Каналы публикации: три честных состояния вместо списка логотипов.
 *
 * Смысл секции — различие «работает» и «заявлено», поэтому статус не украшение,
 * а главный текст плитки. Он берётся из `INTEGRATIONS` и собирается в одну
 * строку: её одинаково читают и тест страницы, и генеративный движок.
 */
export function Integrations() {
  return (
    <section
      className={`${styles.wrap} ${styles.sec}`}
      id="integrations"
      aria-labelledby="integrations-title"
    >
      <div className={`${styles.secHead} ${styles.reveal}`}>
        <span className={styles.pill}>
          <i aria-hidden="true" />
          Каналы публикации
        </span>
        <h2 id="integrations-title">Публикуем туда, где ваша аудитория</h2>
        <p>Доступность каналов обозначена прямо и соответствует текущей конфигурации продукта.</p>
      </div>

      <div className={`${styles.bento} ${styles.stagger}`}>
        {INTEGRATIONS.map((integration, index) => {
          const Icon = integration.icon;
          return (
            <article
              className={`${styles.tile} ${styles[integration.tone]} ${styles.s4}`}
              data-integration={integration.id}
              key={integration.id}
              style={{ "--i": index } as CSSProperties}
            >
              <div className={styles.ico}>
                <Icon aria-hidden="true" strokeWidth={2.2} />
              </div>
              <h3>{integration.title}</h3>
              <p>{integration.text}</p>
              {/* Один текстовый узел: «Статус» и значение не должны разрываться. */}
              <span className={styles.tag}>{`Статус: ${integration.status}`}</span>
            </article>
          );
        })}
      </div>
    </section>
  );
}
