import { AUTHOR } from "@/lib/author";
import { PRODUCT_CONTENT_UPDATED_AT, PRODUCT_NAME_QUOTED } from "@/lib/product";
import styles from "./reference-landing.module.css";

/**
 * Автор и дата обновления.
 *
 * Дата стоит здесь всегда, даже когда автора ещё нет: сигнал свежести работает сам
 * по себе, а выдуманное имя автора — нет. Пока `AUTHOR` равен `null`, блок автора
 * не рендерится, и на странице не остаётся ни пустого места, ни заглушки.
 *
 * Дата задана константой, а не `new Date()`: автоматическая «сегодняшняя» дата
 * сообщает поиску, что страница меняется каждый день, и через две недели этот сигнал
 * перестают учитывать.
 */
export function AuthorSection() {
  return (
    <section className={styles.authorSection} id="author" aria-labelledby="author-title">
      <div className={styles.authorInner}>
        <h2 className={styles.authorHeading} id="author-title">
          Кто отвечает за материал
        </h2>
        {AUTHOR ? (
          <div className={styles.authorCard}>
            <p className={styles.authorName}>{AUTHOR.name}</p>
            <p className={styles.authorRole}>{AUTHOR.role}</p>
            <p className={styles.authorCredential}>{AUTHOR.credential}</p>
            <a className={styles.authorLink} href={AUTHOR.url}>{AUTHOR.urlLabel}</a>
          </div>
        ) : (
          <p className={styles.authorPending}>
            Материал подготовлен командой {PRODUCT_NAME_QUOTED}. Продукт ведёт контент от темы
            до публикации, но юридическую оценку даёт человек.
          </p>
        )}
        <p className={styles.authorUpdated}>Обновлено: {PRODUCT_CONTENT_UPDATED_AT}.</p>
      </div>
    </section>
  );
}
