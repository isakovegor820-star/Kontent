import { JsonLd } from "@/components/seo/json-ld";
import { FAQ_ITEMS, faqPageJsonLd } from "@/lib/seo/faq";
import { publicOrigin } from "@/lib/seo/public-routes";
import { SectionHeading } from "./section-heading";
import styles from "./reference-landing.module.css";

/**
 * Частые вопросы.
 *
 * Каждый вопрос — отдельный `<h3>`, а не строка списка: так вопрос становится
 * самостоятельным входом и в поиске, и в чате. Ответы идут обычным текстом, без
 * аккордеона — содержимое `<details>` тоже попадает в HTML, но лишний слой
 * взаимодействия снижает шанс, что фрагмент вырежут целиком.
 *
 * Разметка FAQPage собирается из того же массива, что рендерит текст. Схема без
 * APP_URL не отдаётся: @id и url с localhost хуже, чем отсутствие разметки.
 * Origin читается внутри компонента, а не на уровне модуля: значение, замороженное
 * при импорте, невозможно проверить тестом и переживает смену окружения.
 */
export function FaqSection() {
  const origin = publicOrigin();
  return (
    <section className={styles.section} id="faq" aria-labelledby="faq-title">
      <div className={styles.container}>
        {origin ? <JsonLd value={faqPageJsonLd(FAQ_ITEMS)} /> : null}
        <SectionHeading
          id="faq-title"
          title="Частые вопросы"
          description="Короткие ответы на то, что спрашивают до регистрации."
        />
        <div className={styles.faqList}>
          {FAQ_ITEMS.map((item) => (
            <article className={styles.faqItem} key={item.question}>
              <h3 className={styles.faqQuestion}>{item.question}</h3>
              <p className={styles.faqAnswer}>{item.answer}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
