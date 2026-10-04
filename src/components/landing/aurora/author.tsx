import { AUTHOR } from "@/lib/author";
import { PRODUCT_CONTENT_UPDATED_AT, PRODUCT_NAME_QUOTED } from "@/lib/product";
import styles from "./bento.module.css";

/**
 * Кто отвечает за материал: подпись — факт, а не украшение.
 *
 * Пока `AUTHOR` пуст, блок не притворяется человеком: команда названа прямо, а граница
 * ответственности (юридическую оценку даёт человек) обозначена здесь же. Выдуманное имя
 * хуже отсутствующего — тест главной уже запрещает заглушки вроде «Имя Фамилия».
 *
 * Обе строки собраны шаблонными литералами: тест ищет дату одним непрерывным текстом,
 * а JSX разрезал бы её на несколько текстовых узлов. Дата берётся константой, а не
 * `new Date()`: ежедневно «свежая» дата перестаёт быть сигналом актуальности.
 */

const NO_AUTHOR_NOTE = `Материал подготовлен командой ${PRODUCT_NAME_QUOTED}. Продукт ведёт контент от темы до публикации, но юридическую оценку даёт человек.`;

const UPDATED = `Обновлено: ${PRODUCT_CONTENT_UPDATED_AT}.`;

export function Author() {
  return (
    <section className={`${styles.wrap} ${styles.sec}`} id="author" aria-labelledby="author-title">
      <div className={`${styles.tile} ${styles.cPearl} ${styles.s12} ${styles.reveal}`}>
        {/* Заголовок и текст разведены по колонкам bento-сетки: отдельного класса для
            такой строки в системе нет, а заводить второй CSS-файл запрещено. На узких
            экранах колонки сами становятся в столбик — медиазапросы уже в модуле. */}
        <div className={styles.bento}>
          <div className={`${styles.secHead} ${styles.s5}`}>
            <h2 id="author-title">Кто отвечает за материал</h2>
          </div>

          <div className={styles.s7}>
            {AUTHOR ? (
              // Карточка появляется вместе с настоящим автором: имя, роль, регалия и ссылка.
              <>
                <p>{AUTHOR.name}</p>
                <p>{AUTHOR.role}</p>
                <p>{AUTHOR.credential}</p>
                <a href={AUTHOR.url}>{AUTHOR.urlLabel}</a>
              </>
            ) : (
              <p>{NO_AUTHOR_NOTE}</p>
            )}
            <p>{UPDATED}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
