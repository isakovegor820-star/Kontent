import type { Tone } from "./content";
import styles from "./bento.module.css";

/**
 * «Контроль материала»: пример проверки одного утверждения до публикации.
 *
 * Это не скриншот продукта, а разбор одного материала по частям: где источник,
 * где дата актуальности, где риск и где решение. Порядок плиток повторяет ход
 * проверки, поэтому он задан данными, а не разметкой.
 *
 * Подписи полей — `span`, а не `p` или `h3`: правила `.tile p` и `.tile h3`
 * специфичнее `.specLabel` и перебили бы его кегль и трекинг.
 */

type SpecField = {
  readonly tone: Tone;
  readonly label: string;
  readonly value: string;
  readonly note: string;
};

/** Четыре состояния проверки. Тон — часть смысла: пастель для состояния, жемчуг для версии. */
const SPEC_FIELDS: readonly SpecField[] = Object.freeze([
  { tone: "cSky", label: "Источник", value: "Указан", note: "ссылка сохранена" },
  { tone: "cMint", label: "Актуальность", value: "Проверена", note: "дата указана" },
  { tone: "cSun", label: "Риск", value: "На проверке", note: "решает юрист" },
  { tone: "cPearl", label: "Версия", value: "Текущая", note: "на согласовании" },
] as const);

export function Product() {
  return (
    <section className={`${styles.wrap} ${styles.sec}`} id="product" aria-labelledby="product-title">
      <div className={`${styles.secHead} ${styles.reveal}`}>
        <span className={styles.pill}>
          <i aria-hidden="true" />
          Контроль материала
        </span>
        <h2 id="product-title">Проверяйте риски и доказательства до публикации</h2>
        <p>
          Аврора связывает значимые утверждения с источниками, датами актуальности и редакционным
          решением. Финальная юридическая оценка остаётся за специалистом.
        </p>
      </div>

      <div className={styles.bento}>
        {/* Белая плитка на всю ширину: образец должен читаться как документ,
            а не как ещё одна витрина возможностей. */}
        <article className={`${styles.tile} ${styles.cPaper} ${styles.s12} ${styles.reveal}`}>
          <span className={styles.specLabel}>Пример проверки материала</span>
          {/* Сканирующая линия: проходит по образцу один раз, когда он попал в кадр. */}
          <span className={styles.specScan} aria-hidden="true" />

          <div className={styles.specGrid}>
            {SPEC_FIELDS.map((field) => (
              <div className={`${styles.tile} ${styles[field.tone]}`} data-spec={field.label} key={field.label}>
                <span className={styles.specLabel}>{field.label}</span>
                <span className={styles.specValue}>{field.value}</span>
                <span className={styles.specNote}>{field.note}</span>
              </div>
            ))}
          </div>

          <div className={styles.specRow}>
            <div className={`${styles.tile} ${styles.cPearl} ${styles.s8}`} data-spec-row="claim">
              <span className={styles.specLabel}>Утверждение</span>
              {/* Заголовок плитки, а не абзац: `.tile h3` — единственный кегль
                  системы около требуемых 19px, инлайн-стили здесь запрещены. */}
              <h3>«Формулировка должна точно отражать условия документа и не обещать результат.»</h3>
            </div>
            <div className={`${styles.tile} ${styles.cGrape} ${styles.s4}`} data-spec-row="decision">
              <span className={styles.specLabel}>Решение редактора</span>
              <span className={styles.specValue}>Требует проверки</span>
              <span className={styles.specNote}>
                Аврора показывает контекст, но не подменяет юридическое решение.
              </span>
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}
