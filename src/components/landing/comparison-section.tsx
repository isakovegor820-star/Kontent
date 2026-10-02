import {
  COMPARISON_COLUMNS,
  COMPARISON_LEGEND,
  COMPARISON_ROWS,
  COMPARISON_VERIFIED_AT,
} from "@/lib/comparison";
import { SectionHeading } from "./section-heading";
import styles from "./reference-landing.module.css";

/**
 * Сравнение с альтернативами.
 *
 * Настоящая `<table>`, а не сетка из `div` и не картинка: таблицу читает и краулер,
 * и генеративный движок, а картинку — никто. Сравнительные запросы («чем заменить…»,
 * «альтернатива…») — самый частый тип промптового спроса в этой нише.
 *
 * Дата проверки данных стоит на странице, а не только в коде: устаревшая строка
 * в сравнении вредит сильнее отсутствующей, и читатель должен видеть, когда её сверяли.
 */
export function ComparisonSection() {
  const noteCount = COMPARISON_ROWS.filter((row) => row.note).length;

  return (
    <section className={styles.section} id="compare" aria-labelledby="compare-title">
      <div className={styles.container}>
        <SectionHeading
          id="compare-title"
          title="Чем Аврора отличается от сервисов отложенного постинга"
          description="Сравнение с оговорками: где мы слабее — написано прямо."
        />
        <div className={styles.compareScroll}>
          <table className={styles.compareTable}>
            <caption className={styles.compareCaption}>
              Сравнение по состоянию на {COMPARISON_VERIFIED_AT}. Источник — официальные сайты сервисов.
            </caption>
            <thead>
              <tr>
                <th scope="col">Критерий</th>
                {COMPARISON_COLUMNS.map((column) => (
                  <th scope="col" key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARISON_ROWS.map((row) => (
                <tr key={row.criterion}>
                  <th scope="row">{row.criterion}</th>
                  {row.cells.map((cell, index) => (
                    <td
                      // Колонки фиксированы и не переупорядочиваются, поэтому индекс здесь стабилен.
                      key={`${row.criterion}-${COMPARISON_COLUMNS[index]}`}
                      className={cell === null ? styles.compareEmpty : undefined}
                    >
                      {cell ?? "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={styles.compareLegend}>{COMPARISON_LEGEND}</p>
        {noteCount > 0 ? (
          <ul className={styles.compareNotes}>
            {COMPARISON_ROWS.filter((row) => row.note).map((row) => (
              <li key={row.criterion}>
                <strong>{row.criterion}.</strong> {row.note}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
