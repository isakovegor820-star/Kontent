import { Logo } from "@/components/brand";
import { CookieSettingsLink } from "@/components/legal/cookie-settings-link";
import { LegalLinks } from "@/components/legal/legal-links";
import { CONTACT_EMAIL, SUPPORT_EMAIL } from "@/lib/contact";
import { PRODUCT_NAME } from "@/lib/product";
import styles from "./bento.module.css";

/**
 * Подвал: бренд, разделы продукта, разборы, связь и документы.
 *
 * Сетка макета рассчитана на четыре колонки ссылок (`1.6fr repeat(4, 1fr)`), поэтому
 * «Связь» и «Документы» делят одну колонку: пятая группа уехала бы на отдельную строку
 * под брендом и раскладка разъехалась бы. Документы приходят из общего `LegalLinks` —
 * правовые адреса не дублируются по подвалам и не печатаются текстом без ссылки.
 *
 * Компонент серверный: подвал обязан быть читаемым и кликабельным без JavaScript,
 * поэтому движение прошлой версии здесь не используется.
 */

/** Колонки без правовых ссылок: документы живут в общей колонке «Связь и документы». */
const COLUMNS = [
  {
    title: "Продукт",
    links: [
      { href: "#features", label: "Что умеет" },
      { href: "#how", label: "Как работает" },
      { href: "#standard", label: "Стандарт" },
      { href: "#access", label: "Доступность" },
    ],
  },
  {
    title: "Каналы",
    links: [
      { href: "#integrations", label: "Telegram и VK" },
      { href: "#product", label: "Контроль материала" },
    ],
  },
  {
    title: "Разборы",
    links: [
      { href: "/guide", label: "Все разборы" },
      { href: "/guide/vidimost-v-chatgpt", label: "Видимость в ChatGPT" },
      { href: "/guide/vidimost-v-alise", label: "Видимость в Алисе AI" },
      { href: "/guide/pochemu-ne-citiruetsya", label: "Почему не цитируют" },
    ],
  },
] as const;

/** Строка состояния каналов — одним текстовым узлом: её читает и человек, и поиск. */
const COPYRIGHT = `© 2026 ${PRODUCT_NAME} · Telegram — работает · VK — после настройки`;

export function Footer() {
  return (
    <footer className={styles.footer} id="footer">
      <div className={styles.wrap}>
        <div className={styles.footerGrid}>
          <div className={styles.footerBrand}>
            <span className={styles.brand}>
              <Logo size={30} decorative />
              {PRODUCT_NAME}
            </span>
            <p>Контент-платформа для планирования и проверки юридических публикаций.</p>
          </div>

          {COLUMNS.map((column) => (
            <div key={column.title}>
              <h4>{column.title}</h4>
              <ul>
                {column.links.map((link) => (
                  <li key={link.href}>
                    <a href={link.href}>{link.label}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <div>
            <h4>Связь и документы</h4>
            <ul>
              <li>
                <a href={`mailto:${CONTACT_EMAIL}`}>Контакты</a>
              </li>
              <li>
                <a href={`mailto:${SUPPORT_EMAIL}`}>Сообщить об ошибке</a>
              </li>
            </ul>
            {/* `notes` — единственный класс системы с вертикальной стопкой и отступом
                сверху; отдельного класса для списка документов в модуле нет. */}
            <LegalLinks className={styles.notes} />
          </div>
        </div>

        <div className={styles.footerBottom}>
          <span>{COPYRIGHT}</span>
          {/* Свой класс компонента (underline) не переопределяем: светлый текст он
              наследует от `footerBottom`, а размер задаёт правило подвала для кнопок. */}
          <CookieSettingsLink />
        </div>
      </div>
    </footer>
  );
}
