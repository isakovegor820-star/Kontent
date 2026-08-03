import Link from "next/link";
import { Send } from "lucide-react";
import styles from "./production-footer.module.css";

const SUPPORT_TG = "https://t.me/kontenfkv_bot";

export function V3ProductionFooter() {
  return (
    <footer id="footer" className={styles.footer}>
      <div className={styles.topline}>
        <span>Аврора</span>
        <p>Автопилот с ручным контролем</p>
        <span>2026</span>
      </div>

      <div className={styles.statement}>
        <span>Ты задаёшь голос, факты и границы.</span>
        <strong>Аврора готовит, проверяет и публикует по расписанию.</strong>
      </div>

      <div className={styles.meta}>
        <p>Автопилот для Telegram-каналов</p>
        <nav aria-label="Разделы лендинга">
          <a href="#how">Как работает</a>
          <a href="#memory">Голос и факты</a>
          <a href="#quality">Контроль</a>
          <a href="#faq">Вопросы</a>
        </nav>
        <div className={styles.actions}>
          <Link href="/register">Запустить первый цикл</Link>
          <a href={SUPPORT_TG}>
            <Send aria-hidden />
            Telegram
          </a>
        </div>
        <span>© 2026 · Аврора</span>
      </div>
    </footer>
  );
}
