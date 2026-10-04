import type { CSSProperties } from "react";
import { Check } from "lucide-react";
import styles from "./bento.module.css";
import { CAPABILITIES, type CapabilityScene as Scene } from "./content";

/**
 * «Контуры редактора»: три плитки о том, что уже есть в материале.
 *
 * У каждой плитки обязательный хук `data-editor-capability`, а у схемы внутри —
 * `data-capability-scene`: по ним контур находят проверки и люди с инструментами.
 * Схемы собраны из примитивов дизайн-системы (чипы полей, пилюли версий, список
 * с галочкой) и потому декоративны: смысл несёт текст, схема лишь показывает его
 * быстрее. Схемы идут после текста — заголовки трёх плиток остаются на одной линии.
 */

/** Поля карточки доказательства: только имена полей, без выдуманных дат и значений. */
const EVIDENCE_FIELDS = ["тип", "источник", "дата"] as const;

function CapabilityScene({ scene }: { readonly scene: Scene }) {
  if (scene === "evidence") {
    return (
      <div data-capability-scene="evidence" aria-hidden="true">
        <div className={styles.vers}>
          {EVIDENCE_FIELDS.map((field) => (
            <span className={styles.chip} key={field}>
              {field}
            </span>
          ))}
        </div>
        <ul className={styles.check}>
          <li>
            <Check aria-hidden="true" strokeWidth={2.2} />
            связано
          </li>
        </ul>
      </div>
    );
  }

  if (scene === "sources") {
    return (
      <div data-capability-scene="sources" aria-hidden="true">
        {/* Два узла и стрелка между ними: публичное и закрытое не сливаются
            в один поток, а соединяются проверкой. */}
        <div className={styles.vers}>
          <b>публичный</b>
          <i aria-hidden="true">→</i>
          <b>закрытый</b>
        </div>
        <ul className={styles.check}>
          <li>
            <Check aria-hidden="true" strokeWidth={2.2} />
            в материале
          </li>
        </ul>
      </div>
    );
  }

  return (
    <div data-capability-scene="history" aria-hidden="true">
      <div className={styles.vers}>
        <b>v.01</b>
        <i aria-hidden="true">→</i>
        <b>v.02</b>
        <i aria-hidden="true">→</i>
        <b className={styles.now}>v.03</b>
      </div>
    </div>
  );
}

export function Evidence() {
  return (
    <section className={`${styles.wrap} ${styles.sec}`} id="evidence" aria-labelledby="evidence-title">
      <div className={`${styles.secHead} ${styles.reveal}`}>
        <span className={styles.pill}>
          <i aria-hidden="true" />
          Контуры редактора
        </span>
        <h2 id="evidence-title">Что уже есть для юридического редактора</h2>
        <p>Три контура, которые формируют проверяемый материал вместо безымянного текста от ИИ.</p>
      </div>

      <div className={`${styles.bento} ${styles.stagger}`}>
        {CAPABILITIES.map((capability, index) => (
          <article
            className={`${styles.tile} ${styles[capability.tone]} ${styles.s4}`}
            data-editor-capability={capability.scene}
            key={capability.scene}
            style={{ "--i": index } as CSSProperties}
          >
            <h3>{capability.title}</h3>
            <p>{capability.text}</p>
            <CapabilityScene scene={capability.scene} />
          </article>
        ))}
      </div>
    </section>
  );
}
