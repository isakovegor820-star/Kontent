import { JsonLd } from "@/components/seo/json-ld";
import { FAQ_ITEMS, faqPageJsonLd } from "@/lib/seo/faq";
import { publicOrigin } from "@/lib/seo/public-routes";
import styles from "./bento.module.css";

/**
 * Частые вопросы — нативный аккордеон `<details>`, как в утверждённом макете.
 *
 * Вопрос стоит внутри `<summary>` ровно одним `<h3>`: так он остаётся отдельным входом
 * и в поиске, и в ответе движка, а ответ лежит в разметке всегда, даже когда блок
 * закрыт, — это условие SEO, а не оформление. JavaScript не нужен: раскрытие делает
 * браузер, поэтому текст виден и до гидратации.
 *
 * Разметка FAQPage собирается из того же массива, что рендерит текст, и не отдаётся
 * без APP_URL: `@id` и `url` с localhost хуже, чем отсутствие разметки.
 */
export function Faq() {
  const origin = publicOrigin();

  return (
    <section className={`${styles.wrap} ${styles.sec}`} id="faq" aria-labelledby="faq-title">
      {origin ? <JsonLd value={faqPageJsonLd(FAQ_ITEMS)} /> : null}

      <div className={`${styles.secHead} ${styles.reveal}`}>
        <span className={styles.pill}>
          <i aria-hidden="true" />
          Вопросы
        </span>
        <h2 id="faq-title">Частые вопросы</h2>
        <p>Ответы на то, что чаще всего спрашивают до регистрации.</p>
      </div>

      <div className={`${styles.faq} ${styles.reveal}`}>
        {FAQ_ITEMS.map((item, index) => (
          <details key={item.question}>
            <summary>
              {/* Номер двузначный: он держит ровную колонку и не «прыгает» на десятом вопросе. */}
              <span className={styles.qn}>{String(index + 1).padStart(2, "0")}</span>
              <h3 className={styles.q}>{item.question}</h3>
              <span className={styles.pl} aria-hidden="true">
                +
              </span>
            </summary>
            <div className={styles.ans}>{item.answer}</div>
          </details>
        ))}
      </div>
    </section>
  );
}
