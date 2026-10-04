import type { CSSProperties } from "react";
import { Check, Minus } from "lucide-react";
import styles from "./bento.module.css";
import { ACCESS_CARDS, type AccessCard } from "./content";

/**
 * Фактический статус рабочих контуров.
 *
 * Карточки целиком берутся из `ACCESS_CARDS`: статус на экране не может разойтись
 * с текстом продукта. Хук `data-access-card` отмечает контур, чтобы тест страницы
 * проверял именно эти три карточки, а не любые совпадения слов.
 */

/** Цвет точки статуса: живой контур — фиолетовый, ожидающий настройки — оранжевый. */
const STATUS_COLOR: Record<AccessCard["state"], string> = {
  live: "var(--grape)",
  setup: "#c25a00",
};

export function Access() {
  return (
    <section className={`${styles.wrap} ${styles.sec}`} id="access" aria-labelledby="access-title">
      <div className={`${styles.secHead} ${styles.reveal}`}>
        <span className={styles.pill}>
          <i aria-hidden="true" />
          Доступ
        </span>
        <h2 id="access-title">Фактический статус рабочих контуров</h2>
        <p>Статус каждого контура обозначен прямо и соответствует текущей конфигурации продукта.</p>
      </div>

      {/* `--i` задаёт ступень лестницы: карточки поднимаются по очереди, а не разом. */}
      <div className={`${styles.bento} ${styles.stagger}`}>
        {ACCESS_CARDS.map((card, index) => (
          <article
            className={`${styles.tile} ${styles.cPaper} ${styles.s4}`}
            data-access-card={card.tone}
            key={card.tone}
            style={{ "--i": index } as CSSProperties}
          >
            {/* Точка и подпись — один текстовый узел: строку статуса читает и тест, и движок. */}
            <span className={styles.tag} style={{ color: STATUS_COLOR[card.state] }}>
              {`● ${card.status}`}
            </span>

            <h3>{card.title}</h3>
            <p>{card.note}</p>

            {/* Галочка — то, что уже работает; минус — то, что ждёт настройки. */}
            <ul className={styles.check}>
              {card.features.map((feature) => (
                <li key={feature}>
                  {card.state === "live" ? (
                    <Check aria-hidden="true" strokeWidth={2.2} />
                  ) : (
                    <Minus aria-hidden="true" strokeWidth={2.2} />
                  )}
                  {feature}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}
