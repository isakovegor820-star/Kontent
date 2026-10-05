import type { CSSProperties } from "react";
import { Check, Minus } from "lucide-react";
import styles from "./bento.module.css";
import { ACCESS_CARDS } from "./content";

/**
 * Фактический статус рабочих контуров.
 *
 * Карточки целиком берутся из `ACCESS_CARDS`: статус на экране не может разойтись
 * с текстом продукта. Хук `data-access-card` отмечает контур, чтобы тест страницы
 * проверял именно эти три карточки, а не любые совпадения слов.
 *
 * Плитки цветные, как остальная мозаика страницы: белыми они выпадали из bento и
 * читались как служебный список. Тона совпадают с секцией каналов — Telegram небо,
 * ВКонтакте синий, — а редактор несёт гранат как главный рабочий контур.
 */
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
        {ACCESS_CARDS.map((card, index) => {
          const Icon = card.icon;
          return (
            <article
              className={`${styles.tile} ${styles[card.color]} ${styles.s4}`}
              data-access-card={card.tone}
              key={card.tone}
              style={{ "--i": index } as CSSProperties}
            >
              <div className={styles.ico}>
                <Icon aria-hidden="true" strokeWidth={2.2} />
              </div>

              {/* Статус — точка и подпись в пилюле: состояние несёт цвет точки,
                  поэтому подпись читается и на пастели, и на градиенте. */}
              <span className={styles.status} data-state={card.state}>
                <i aria-hidden="true" />
                {card.status}
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
          );
        })}
      </div>
    </section>
  );
}
