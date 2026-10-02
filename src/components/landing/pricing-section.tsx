import { PRICING } from "@/lib/pricing";
import { PRODUCT_DISCLAIMER } from "@/lib/product";
import { SectionHeading } from "./section-heading";
import styles from "./reference-landing.module.css";

/**
 * Что входит и сколько стоит.
 *
 * Пока `PRICING` пуст, компонент не рендерит ничего: ни пустой таблицы, ни заглушки
 * «цена по запросу». Заглушка на месте цены читается как уклонение и хуже отсутствия
 * блока. Как только тариф появится в `lib/pricing.ts`, таблица и вопрос в FAQ
 * включатся одним изменением.
 *
 * Дисклеймер стоит под таблицей всегда: это информационный материал о продукте,
 * а не юридическая консультация.
 */
export function PricingSection() {
  if (PRICING.length === 0) return null;

  return (
    <section className={styles.section} id="pricing" aria-labelledby="pricing-title">
      <div className={styles.container}>
        <SectionHeading
          id="pricing-title"
          title="Что входит и сколько стоит"
          description="Один контур: контент-план, источники, согласование и публикация. Без доплат за участников команды."
        />
        <div className={styles.pricingGrid}>
          {PRICING.map((plan) => (
            <article className={styles.pricingCard} key={plan.name}>
              <h3 className={styles.pricingName}>{plan.name}</h3>
              <p className={styles.pricingPrice}>{plan.price}</p>
              <p className={styles.pricingAudience}>{plan.audience}</p>
              <ul className={styles.pricingIncludes}>
                {plan.includes.map((item) => (
                  <li key={item}>
                    <span className={styles.fitMarkYes} aria-hidden="true">✓</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
        <p className={styles.pricingNote}>{PRODUCT_DISCLAIMER}</p>
      </div>
    </section>
  );
}
