import type { CSSProperties } from "react";
import { Check, Link2, Lock } from "lucide-react";
import styles from "./bento.module.css";
import { CAPABILITIES, type CapabilityScene as Scene } from "./content";

/**
 * «Контуры редактора»: три плитки о том, что уже есть в материале.
 *
 * У каждой плитки обязательный хук `data-editor-capability`, а у схемы внутри —
 * `data-capability-scene`: по ним контур находят проверки и люди с инструментами.
 *
 * Схемы — миниатюры рабочего интерфейса, а не подписи: карточка доказательства
 * показывает поля документа, контур источника — что допущено в материал, история —
 * как версия доходит до согласования. Поэтому вместо отдельных слов («связано»,
 * «в материале») здесь строки с подписью и значением, состояние узла и вердикт
 * строкой. Всё декоративно: смысл несёт текст карточки, схема лишь показывает его
 * быстрее, и скринридер её не читает.
 */

/**
 * Данные сцен. Типы описаны явно, а не выведены из `as const`: у части строк есть
 * необязательные признаки (ссылка, текущая версия), и без общего типа обращение
 * к ним не проходит проверку.
 */
type EvidenceRow = {
  readonly label: string;
  readonly value: string;
  /** Источник открывается ссылкой — в документе это отдельный знак. */
  readonly linked?: boolean;
};

type SourceRow = {
  readonly label: string;
  readonly note: string;
  readonly state: "open" | "closed";
};

type VersionRow = {
  readonly version: string;
  readonly status: string;
  readonly date: string;
  readonly current?: boolean;
};

/** Поля карточки доказательства: форма документа, без выдуманных фактов о клиенте. */
const EVIDENCE_ROWS: readonly EvidenceRow[] = [
  { label: "Тип", value: "Разъяснение нормы" },
  { label: "Источник", value: "ГК РФ, ст. 429", linked: true },
  { label: "Актуально на", value: "16.07.2026" },
];

/** Два контура источников: один открыт для материала, второй закрыт. */
const SOURCE_ROWS: readonly SourceRow[] = [
  { label: "Публичная лента", note: "разрешена", state: "open" },
  { label: "Закрытый контур", note: "не допущен", state: "closed" },
];

/** Версии материала: что происходило с каждой и где она сейчас. */
const VERSION_ROWS: readonly VersionRow[] = [
  { version: "v.01", status: "черновик", date: "12 авг" },
  { version: "v.02", status: "комментарий юриста", date: "14 авг" },
  { version: "v.03", status: "согласовано", date: "16 авг", current: true },
];

function CapabilityScene({ scene }: { readonly scene: Scene }) {
  if (scene === "evidence") {
    return (
      <div className={styles.scene} data-capability-scene="evidence" aria-hidden="true">
        <div className={styles.scenePanel}>
          <div className={styles.sceneHead}>
            <span>Доказательство</span>
            <b className={styles.sceneBadge}>
              <Check strokeWidth={2.6} />
              привязано
            </b>
          </div>

          <dl className={styles.sceneRows}>
            {EVIDENCE_ROWS.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>
                  {row.value}
                  {row.linked ? <Link2 strokeWidth={2.4} /> : null}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    );
  }

  if (scene === "sources") {
    return (
      <div className={styles.scene} data-capability-scene="sources" aria-hidden="true">
        <div className={styles.scenePanel}>
          <div className={styles.sceneHead}>
            <span>Контур источника</span>
            <b className={styles.sceneBadge}>
              <Check strokeWidth={2.6} />
              проверен
            </b>
          </div>

          <ul className={styles.sourceRows}>
            {SOURCE_ROWS.map((row) => (
              <li key={row.label} data-state={row.state}>
                {/* Галочка — контур открыт для материала, замок — закрыт.
                    Разные знаки важнее разных подписей: состояние видно сразу. */}
                <span className={styles.sourceMark}>
                  {row.state === "open" ? <Check strokeWidth={2.6} /> : <Lock strokeWidth={2.4} />}
                </span>
                <span className={styles.sourceName}>{row.label}</span>
                <span className={styles.sourceNote}>{row.note}</span>
              </li>
            ))}
          </ul>

          <p className={styles.sourceVerdict}>В материал попадает только разрешённое</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.scene} data-capability-scene="history" aria-hidden="true">
      <div className={styles.scenePanel}>
        <div className={styles.sceneHead}>
          <span>История версий</span>
          <b className={styles.sceneBadge}>{VERSION_ROWS.length} версии</b>
        </div>

        <ol className={styles.versionList}>
          {VERSION_ROWS.map((row) => (
            <li key={row.version} data-current={row.current ? "yes" : "no"}>
              <span className={styles.versionDot} />
              <b>{row.version}</b>
              <span className={styles.versionStatus}>{row.status}</span>
              <span className={styles.versionDate}>{row.date}</span>
            </li>
          ))}
        </ol>
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
        {CAPABILITIES.map((capability, index) => {
          const Icon = capability.icon;
          return (
            <article
              className={`${styles.tile} ${styles[capability.tone]} ${styles.s4}`}
              data-editor-capability={capability.scene}
              key={capability.scene}
              style={{ "--i": index } as CSSProperties}
            >
              {/* Иконка в квадрате — как у остальных плиток мозаики: без неё
                  карточка читалась как текстовый блок, а не как плитка. */}
              <div className={styles.ico}>
                <Icon aria-hidden="true" strokeWidth={2.2} />
              </div>
              <h3>{capability.title}</h3>
              <p>{capability.text}</p>
              <CapabilityScene scene={capability.scene} />
            </article>
          );
        })}
      </div>
    </section>
  );
}
