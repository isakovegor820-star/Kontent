import { Check } from "lucide-react";
import { PRICING } from "@/lib/pricing";
import { PRODUCT_DISCLAIMER } from "@/lib/product";
import styles from "./bento.module.css";

/**
 * Тарифы. Пока `PRICING` пуст, секция не рендерится вовсе — ни пустой плитки,
 * ни строки «цена по запросу»: заглушка на месте цены читается как уклонение.
 * Как только тариф появится одной записью в `lib/pricing.ts`, блок включается сам.
 */
export function Pricing() {
  if (PRICING.length === 0) return null;

  return (
    <section className={`${styles.wrap} ${styles.sec}`} id="pricing" aria-labelledby="pricing-title">
      <div className={`${styles.secHead} ${styles.reveal}`}>
        <span className={styles.pill}>
          <i aria-hidden="true" />
          Тариф
        </span>
        <h2 id="pricing-title">Что входит и сколько стоит</h2>
        <p>Один контур: контент-план, источники, согласование и публикация.</p>
      </div>

      <div className={`${styles.bento} ${styles.stagger}`}>
        {PRICING.map((plan, index) => (
          <article
            className={`${styles.tile} ${styles.cPaper} ${styles.s4}`}
            key={plan.name}
            style={{ "--i": index } as React.CSSProperties}
          >
            <h3>{plan.name}</h3>
            <div className={styles.specValue}>{plan.price}</div>
            <p>{plan.audience}</p>
            <ul className={styles.check}>
              {plan.includes.map((item) => (
                <li key={item}>
                  <Check aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>

      <p className={styles.legend}>{PRODUCT_DISCLAIMER}</p>
    </section>
  );
}
