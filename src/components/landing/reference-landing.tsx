import type { ReactNode } from "react";
import {
  ArrowRight,
  BookOpenCheck,
  CalendarDays,
  Check,
  ClipboardCheck,
  Clock3,
  FileCheck2,
  History,
  Scale,
  Send,
  Settings2,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { Logo } from "@/components/brand";
import { HeroProductScene } from "./hero-product-scene";
import { LandingMobileNav } from "./landing-mobile-nav";
import styles from "./reference-landing.module.css";

type Feature = {
  icon: ReactNode;
  title: string;
  text: string;
};

const features: Feature[] = [
  {
    icon: <CalendarDays aria-hidden="true" />,
    title: "Планирование публикаций",
    text: "Собирайте контент-план, готовьте материалы и назначайте время публикации в Telegram.",
  },
  {
    icon: <Clock3 aria-hidden="true" />,
    title: "Единый календарь",
    text: "Проверяйте всю неделю, находите пробелы и переносите материалы без ручных таблиц.",
  },
  {
    icon: <BookOpenCheck aria-hidden="true" />,
    title: "Факты и доказательства",
    text: "Добавляйте к утверждениям источник, дату актуальности и правила использования.",
  },
  {
    icon: <UsersRound aria-hidden="true" />,
    title: "Командная работа",
    text: "Роли, версии, комментарии и решения остаются рядом с материалом.",
  },
  {
    icon: <ClipboardCheck aria-hidden="true" />,
    title: "Редакционное согласование",
    text: "Отправляйте точную версию на проверку и сохраняйте историю решений.",
  },
  {
    icon: <ShieldCheck aria-hidden="true" />,
    title: "Контроль перед публикацией",
    text: "Аврора отмечает конфликтные настройки, а финальное решение принимает юрист.",
  },
];

const steps = [
  {
    icon: <Settings2 aria-hidden="true" />,
    title: "Настройте проект",
    text: "Добавьте данные о практике, аудитории и правилах юридического контента.",
  },
  {
    icon: <CalendarDays aria-hidden="true" />,
    title: "Соберите контент-план",
    text: "Разложите темы по датам и подготовьте отдельные редактируемые материалы.",
  },
  {
    icon: <BookOpenCheck aria-hidden="true" />,
    title: "Привяжите доказательства",
    text: "Укажите источник, актуальность и допустимую формулировку для значимых фактов.",
  },
  {
    icon: <Send aria-hidden="true" />,
    title: "Согласуйте и опубликуйте",
    text: "Подтвердите версию и отправьте её в Telegram. VK доступен после настройки интеграции.",
  },
];

const editorCapabilities: Feature[] = [
  {
    icon: <FileCheck2 aria-hidden="true" />,
    title: "Карточка доказательства",
    text: "Тип, содержание, источник и дата актуальности хранятся вместе с настройками материала.",
  },
  {
    icon: <Scale aria-hidden="true" />,
    title: "Юридические источники",
    text: "Публичные ленты и разрешённые подключения отделены от закрытых и неподтверждённых данных.",
  },
  {
    icon: <History aria-hidden="true" />,
    title: "История согласования",
    text: "Комментарии и решения относятся к конкретной версии и не теряются после правок.",
  },
];

const accessCards = [
  {
    status: "Доступно",
    title: "Редактор и контент-план",
    note: "Основной рабочий контур для подготовки юридического контента.",
    features: ["Черновики и календарь", "Источники и доказательства", "Настройки тона, включая необязательный мат"],
  },
  {
    status: "Работает",
    title: "Telegram",
    note: "Подключение канала, расписание и серверная публикация.",
    features: ["Публикация по расписанию", "Статусы и история операций", "Повторная попытка без дублей"],
  },
  {
    status: "После настройки",
    title: "ВКонтакте",
    note: "Доступность зависит от настроенного приложения и тестового сообщества.",
    features: ["Подключение сообщества", "Проверка разрешений", "Статус готовности внутри проекта"],
  },
];

function SectionHeading({
  id,
  eyebrow,
  title,
  description,
}: {
  id: string;
  eyebrow: string;
  title: string;
  description?: string;
}) {
  return (
    <div className={styles.sectionHeading}>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h2 id={id}>{title}</h2>
      {description ? <p>{description}</p> : null}
    </div>
  );
}

function BrandLockup() {
  return (
    <span className={styles.brandLockup}>
      <Logo size={34} decorative />
      <span>Аврора</span>
    </span>
  );
}

export function ReferenceLanding() {
  return (
    <div className={styles.site}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <a className={styles.brandLink} href="#top" aria-label="Аврора — на главную">
            <BrandLockup />
          </a>
          <nav className={styles.nav} aria-label="Основная навигация">
            <a href="#product">Продукт</a>
            <a href="#features">Возможности</a>
            <a href="#how">Как работает</a>
            <a href="#integrations">Интеграции</a>
            <a href="#access">Доступ</a>
          </nav>
          <div className={styles.headerActions}>
            <a className={styles.loginLink} href="/login">Войти</a>
            <a className={styles.primaryButton} href="/register">Создать аккаунт</a>
          </div>
          <LandingMobileNav />
        </div>
      </header>

      <main id="main">
        <section className={styles.hero} id="top" aria-labelledby="hero-title">
          <div className={styles.heroGlow} aria-hidden="true" />
          <div className={styles.heroInner}>
            <div className={styles.heroCopy}>
              <p className={styles.eyebrow}>SMM-платформа для юридического контента</p>
              <h1 id="hero-title">Юридический контент с проверкой рисков и доказательств</h1>
              <p className={styles.heroLead}>
                Планируйте публикации, фиксируйте источники, согласовывайте формулировки
                и отправляйте готовые материалы в Telegram.
              </p>
              <div className={styles.heroActions}>
                <a className={styles.primaryButtonLarge} href="/register">
                  Создать первый материал
                  <ArrowRight aria-hidden="true" />
                </a>
                <span className={styles.trialNote}>
                  <strong>Telegram работает</strong>
                  VK — после настройки
                </span>
              </div>
              <ul className={styles.heroBenefits} aria-label="Основные возможности">
                <li><Check aria-hidden="true" />Контент-план и редактор</li>
                <li><Check aria-hidden="true" />Источники и доказательства</li>
                <li><Check aria-hidden="true" />Согласование перед публикацией</li>
              </ul>
            </div>
            <HeroProductScene />
          </div>
        </section>

        <section className={styles.trustBar} aria-label="Фактические возможности Авроры">
          <div className={styles.brandMarquee}>
            <span>Контент-план</span>
            <span>Доказательства</span>
            <span>Согласование</span>
            <span>Telegram</span>
            <span>VK после настройки</span>
          </div>
        </section>

        <section className={styles.section} id="features" aria-labelledby="features-title">
          <div className={styles.container}>
            <SectionHeading
              id="features-title"
              eyebrow="Возможности"
              title="Рабочий контур для юридической редакции"
              description="От темы и доказательств до согласованной версии и контролируемой публикации."
            />
            <div className={styles.featureGrid}>
              {features.map((feature) => (
                <article className={styles.featureCard} key={feature.title}>
                  <span className={styles.featureIcon}>{feature.icon}</span>
                  <div>
                    <h3>{feature.title}</h3>
                    <p>{feature.text}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.processSection}`} id="how" aria-labelledby="how-title">
          <div className={styles.container}>
            <SectionHeading
              id="how-title"
              eyebrow="Как это работает"
              title="От идеи до согласованной публикации"
              description="Четыре шага сохраняют смысл, источники и ответственность за финальную версию."
            />
            <ol className={styles.steps}>
              {steps.map((step, index) => (
                <li className={styles.step} key={step.title}>
                  <div className={styles.stepTop}>
                    <span className={styles.stepIcon}>{step.icon}</span>
                    <span className={styles.stepNumber}>0{index + 1}</span>
                  </div>
                  <h3>{step.title}</h3>
                  <p>{step.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className={styles.analyticsSection} id="product" aria-labelledby="product-title">
          <div className={`${styles.container} ${styles.analyticsShell}`}>
            <div className={styles.analyticsIntro}>
              <p className={styles.eyebrow}>Юридический контроль</p>
              <h2 id="product-title">Проверяйте риски и доказательства до публикации</h2>
              <p>
                Аврора связывает значимые утверждения с источниками, датами актуальности
                и редакционным решением. Финальная юридическая оценка остаётся за специалистом.
              </p>
              <ul className={styles.analyticsList}>
                <li><Check aria-hidden="true" />Источник рядом с утверждением</li>
                <li><Check aria-hidden="true" />Дата актуальности доказательства</li>
                <li><Check aria-hidden="true" />Комментарии к конкретной версии</li>
                <li><Check aria-hidden="true" />История согласования</li>
              </ul>
              <a className={styles.secondaryButton} href="/register">
                Создать материал
                <ArrowRight aria-hidden="true" />
              </a>
            </div>

            <div className={styles.dashboard} aria-label="Демонстрация структуры проверки материала">
              <p className={styles.dashboardEyebrow}>Пример проверки материала</p>
              <div className={styles.metricGrid}>
                <article><span>Источник</span><strong>Указан</strong><small>ссылка сохранена</small></article>
                <article><span>Актуальность</span><strong>Проверена</strong><small>дата указана</small></article>
                <article><span>Риск</span><strong>На проверке</strong><small>решает юрист</small></article>
                <article><span>Версия</span><strong>Текущая</strong><small>на согласовании</small></article>
              </div>
              <div className={styles.chartGrid}>
                <article className={styles.lineChartCard}>
                  <div className={styles.chartHeader}>
                    <strong>Утверждение и доказательство</strong>
                    <span>Демонстрация</span>
                  </div>
                  <div className={styles.evidenceStatement}>
                    <span>Утверждение</span>
                    <p>Формулировка должна точно отражать условия документа и не обещать результат.</p>
                  </div>
                  <dl className={styles.evidenceRows}>
                    <div><dt>Источник</dt><dd>Документ проекта</dd></div>
                    <div><dt>Актуальность</dt><dd>Дата указана</dd></div>
                    <div><dt>Использование</dt><dd>Требует согласования</dd></div>
                  </dl>
                </article>
                <article className={styles.donutCard}>
                  <strong>Решение редактора</strong>
                  <div className={styles.reviewDecision}>
                    <ShieldCheck aria-hidden="true" />
                    <span>Требует проверки</span>
                    <p>Аврора показывает контекст, но не подменяет юридическое решение.</p>
                  </div>
                  <ul>
                    <li><i /><span>Источник</span><b>есть</b></li>
                    <li><i /><span>Дата</span><b>есть</b></li>
                    <li><i /><span>Решение</span><b>ожидается</b></li>
                  </ul>
                </article>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.socialSection} id="integrations" aria-labelledby="integrations-title">
          <div className={styles.container}>
            <p className={styles.eyebrow} id="integrations-title">Статус интеграций</p>
            <div className={styles.socialList}>
              <span>
                <i className={styles.telegramIcon}>➤</i>
                <span className={styles.socialCopy}><strong>Telegram</strong><small>публикация работает</small></span>
              </span>
              <span>
                <i className={styles.vkIcon}>VK</i>
                <span className={styles.socialCopy}><strong>ВКонтакте</strong><small>после настройки приложения</small></span>
              </span>
              <span>
                <ShieldCheck aria-hidden="true" />
                <span className={styles.socialCopy}><strong>Другие сети</strong><small>пока не заявлены как подключённые</small></span>
              </span>
            </div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.reviewsSection}`} id="evidence" aria-labelledby="evidence-title">
          <div className={styles.container}>
            <SectionHeading
              id="evidence-title"
              eyebrow="Основа продукта"
              title="Что уже есть для юридического редактора"
              description="Три контура, которые формируют проверяемый материал вместо безымянного текста от ИИ."
            />
            <div className={styles.reviewGrid}>
              {editorCapabilities.map((capability) => (
                <article className={`${styles.reviewCard} ${styles.capabilityCard}`} key={capability.title}>
                  <span className={styles.capabilityIcon}>{capability.icon}</span>
                  <h3>{capability.title}</h3>
                  <p>{capability.text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.pricingSection}`} id="access" aria-labelledby="access-title">
          <div className={styles.container}>
            <SectionHeading
              id="access-title"
              eyebrow="Доступность"
              title="Фактический статус рабочих контуров"
              description="Доступность каждого контура обозначена прямо и соответствует текущей конфигурации продукта."
            />
            <div className={`${styles.pricingGrid} ${styles.accessGrid}`}>
              {accessCards.map((card) => (
                <article className={`${styles.priceCard} ${styles.accessCard}`} key={card.title}>
                  <span className={styles.accessStatus}>{card.status}</span>
                  <h3>{card.title}</h3>
                  <p className={styles.planNote}>{card.note}</p>
                  <ul>
                    {card.features.map((feature) => <li key={feature}><Check aria-hidden="true" />{feature}</li>)}
                  </ul>
                </article>
              ))}
            </div>
            <div className={styles.accessAction}>
              <a className={styles.secondaryButton} href="/register">
                Создать аккаунт
                <ArrowRight aria-hidden="true" />
              </a>
              <p>Готовность конкретного подключения отображается внутри проекта.</p>
            </div>
          </div>
        </section>

        <section className={styles.ctaSection} aria-labelledby="cta-title">
          <div className={`${styles.container} ${styles.ctaCard}`}>
            <div className={styles.ctaMark} aria-hidden="true"><Logo size={68} decorative /></div>
            <div className={styles.ctaCopy}>
              <h2 id="cta-title">Начните с проверяемого материала</h2>
              <p>Создайте проект, добавьте источники и подготовьте первую согласованную публикацию.</p>
            </div>
            <a className={styles.whiteButton} href="/register">
              Создать аккаунт
              <ArrowRight aria-hidden="true" />
            </a>
            <div className={styles.ctaOrbit} aria-hidden="true"><span>✦</span></div>
          </div>
        </section>
      </main>

      <footer className={styles.footer} id="footer">
        <div className={styles.footerInner}>
          <div className={styles.footerBrand}>
            <BrandLockup />
            <p>Платформа для планирования и проверки юридического контента.</p>
            <small>© 2026 Аврора. Все права защищены.</small>
          </div>
          <div className={styles.footerLinks}>
            <div><strong>Продукт</strong><a href="#features">Возможности</a><a href="#how">Как работает</a><a href="#access">Доступность</a></div>
            <div><strong>Интеграции</strong><a href="#integrations">Telegram и VK</a><a href="#product">Контроль материала</a></div>
            <div><strong>Связь</strong><a href="mailto:hello@avrora.app">Контакты</a><a href="mailto:help@avrora.app">Сообщить об ошибке</a></div>
            <div><strong>Документы</strong><a href="/terms">Условия использования</a><a href="/privacy">Конфиденциальность</a></div>
          </div>
          <div className={styles.footerSocial}>
            <strong>Статус интеграций</strong>
            <p>Telegram — работает<br />VK — после настройки</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
