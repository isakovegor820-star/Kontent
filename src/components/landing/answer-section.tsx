import { PRODUCT_ANSWER, PRODUCT_DISCLAIMER } from "@/lib/product";
import styles from "./reference-landing.module.css";

/**
 * Прямой ответ на вопрос «что это» — первый текстовый блок страницы.
 *
 * Стоит отдельной секцией сразу после первого экрана, а не внутри него: hero собран
 * под короткий слоган, и абзац на 56 слов развалил бы композицию. Для краулера важен
 * порядок в разметке, и здесь он соблюдён — ответ идёт до всех остальных блоков.
 *
 * Не аккордеон, не картинка, не «читать далее»: текст обязан быть в первом HTML.
 */
export function AnswerSection() {
  return (
    <section className={styles.answerSection} id="answer" aria-labelledby="answer-title">
      <div className={styles.answerInner}>
        <h2 className={styles.answerLabel} id="answer-title">
          Коротко
        </h2>
        <p className={styles.answerText}>{PRODUCT_ANSWER}</p>
        <p className={styles.answerDisclaimer}>{PRODUCT_DISCLAIMER}</p>
      </div>
    </section>
  );
}
