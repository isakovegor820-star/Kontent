import type { CSSProperties } from "react";
import { Check, Minus } from "lucide-react";
import { PRODUCT_DOES_NOT_FIT, PRODUCT_FITS } from "@/lib/product";
import styles from "./bento.module.css";

/**
 * Границы продукта: кому подходит и кому нет.
 *
 * Вторая плитка здесь не для симметрии. Страница, которая честно отговаривает часть
 * читателей, читается как источник, а не как реклама, — и именно её цитируют.
 * Тон плиток разный, потому что разный смысл: «подойдёт» — мягкая мята,
 * «не подойдёт» — тёплый персик.
 *
 * Текст пункта остаётся одним текстовым узлом, а иконка — соседним элементом:
 * список цитируется построчно, без склейки слов и разрывов. Иконки декоративны и
 * скрыты от скринридера — смысл несёт текст.
 */

const CARDS = [
  { tone: "cMint", icon: Check, title: "Подойдёт, если", items: PRODUCT_FITS },
  { tone: "cPeach", icon: Minus, title: "Не подойдёт, если", items: PRODUCT_DOES_NOT_FIT },
] as const;

export function Fit() {
  return (
    <section className={`${styles.wrap} ${styles.sec}`} id="fit" aria-labelledby="fit-title">
      <div className={`${styles.secHead} ${styles.reveal}`}>
        <span className={styles.pill}>
          <i aria-hidden="true" />
          Проверьте себя
        </span>
        <h2 id="fit-title">Кому подходит Аврора</h2>
        <p>
          Аврора закрывает конкретный контур, а не весь маркетинг. Ниже — честные условия, при
          которых она приносит пользу.
        </p>
      </div>

      <div className={`${styles.bento} ${styles.stagger}`}>
        {CARDS.map((card, index) => {
          const Icon = card.icon;
          return (
            <article
              className={`${styles.tile} ${styles[card.tone]} ${styles.s6}`}
              key={card.title}
              style={{ "--i": index } as CSSProperties}
            >
              <div className={styles.ico}>
                <Icon aria-hidden="true" strokeWidth={2.2} />
              </div>
              <h3>{card.title}</h3>
              <ul className={styles.check}>
                {card.items.map((item) => (
                  <li key={item}>
                    <Icon aria-hidden="true" strokeWidth={2.2} />
                    {item}
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
