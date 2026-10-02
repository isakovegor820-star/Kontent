import styles from "./reference-landing.module.css";

/**
 * Заголовок секции. Вынесен из `reference-landing.tsx`, чтобы новые блоки брали ту же
 * разметку и те же классы, а не заводили вторую типографику. Файл стилей общий:
 * CSS-модуль отдаёт одинаковые имена классов любому, кто его импортирует.
 */
export function SectionHeading({
  id,
  title,
  description,
}: {
  id: string;
  title: string;
  description?: string;
}) {
  return (
    <div className={styles.sectionHeading}>
      <h2 id={id}>{title}</h2>
      {description ? <p>{description}</p> : null}
    </div>
  );
}
