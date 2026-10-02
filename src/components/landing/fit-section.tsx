import { PRODUCT_DOES_NOT_FIT, PRODUCT_FITS } from "@/lib/product";
import { SectionHeading } from "./section-heading";
import styles from "./reference-landing.module.css";

/**
 * Кому подходит и кому не подходит.
 *
 * Вторая колонка здесь не для баланса. Страница, которая честно отговаривает часть
 * читателей, читается как источник, а не как реклама, и именно такие страницы движки
 * охотнее берут в ответ. Половина отказов на входе дешевле потока нецелевых регистраций.
 */
export function FitSection() {
  return (
    <section className={styles.section} id="fit" aria-labelledby="fit-title">
      <div className={styles.container}>
        <SectionHeading
          id="fit-title"
          title="Кому подходит Аврора"
          description="Проверьте себя до регистрации: продукт закрывает конкретный контур, а не весь маркетинг."
        />
        <div className={styles.fitGrid}>
          <div className={styles.fitColumn}>
            <h3 className={styles.fitTitle}>Подойдёт, если</h3>
            <ul className={styles.fitList}>
              {PRODUCT_FITS.map((item) => (
                <li key={item} className={styles.fitItem}>
                  <span className={styles.fitMarkYes} aria-hidden="true">✓</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className={`${styles.fitColumn} ${styles.fitColumnNo}`}>
            <h3 className={styles.fitTitle}>Не подойдёт, если</h3>
            <ul className={styles.fitList}>
              {PRODUCT_DOES_NOT_FIT.map((item) => (
                <li key={item} className={styles.fitItem}>
                  <span className={styles.fitMarkNo} aria-hidden="true">—</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
