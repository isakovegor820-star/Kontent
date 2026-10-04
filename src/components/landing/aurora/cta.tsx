import { ArrowRight } from "lucide-react";
import styles from "./bento.module.css";

/**
 * Последний призыв: одно действие и одна причина его сделать.
 *
 * Отступ сверху снят инлайном осознанно: секция продолжает предыдущий блок, и второй
 * такой же отступ разрывал бы пару «вопрос — действие». Больше инлайн-стилей нет —
 * всё остальное берётся из общего модуля.
 */
export function Cta() {
  return (
    <section
      className={`${styles.wrap} ${styles.sec}`}
      id="cta"
      aria-labelledby="cta-title"
      style={{ paddingBlockStart: 0 }}
    >
      <div className={`${styles.cta} ${styles.reveal}`}>
        <div className={styles.ctaIn}>
          <div>
            <h2 id="cta-title">Начните с проверяемого материала</h2>
            <p>Создайте проект, добавьте источники и подготовьте первую согласованную публикацию.</p>
          </div>
          <a className={`${styles.btn} ${styles.btnWhite}`} href="/register">
            Создать аккаунт <ArrowRight aria-hidden="true" strokeWidth={2.2} />
          </a>
        </div>
      </div>
    </section>
  );
}
