import type { ReactNode } from "react";
import {
  ArrowRight,
  BarChart3,
  BookOpenCheck,
  Check,
  ClipboardCheck,
  Compass,
  FileCheck2,
  Gauge,
  History,
  Radar,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Logo } from "@/components/brand";
import { EvidenceEngine } from "./evidence-engine";
import { LandingMobileNav } from "./landing-mobile-nav";
import styles from "./reference-landing.module.css";

type Feature = {
  icon: ReactNode;
  title: string;
  text: string;
};

const features: Feature[] = [
  {
    icon: <Radar aria-hidden="true" />,
    title: "Сигнал относительно нормы",
    text: "Аврора сравнивает пост не с чужими миллионниками, а с медианой его собственного канала.",
  },
  {
    icon: <Compass aria-hidden="true" />,
    title: "Причина, а не огонёк",
    text: "Показывает источник, свежесть, цифры и механику: какой хук, тема и структура дали результат.",
  },
  {
    icon: <Sparkles aria-hidden="true" />,
    title: "Новый угол вместо копии",
    text: "Берёт работающий принцип, сверяет историю вашего канала и собирает самостоятельный материал.",
  },
  {
    icon: <BookOpenCheck aria-hidden="true" />,
    title: "Факты рядом с текстом",
    text: "Значимые утверждения, источник и дата актуальности остаются в одной карточке материала.",
  },
  {
    icon: <ClipboardCheck aria-hidden="true" />,
    title: "Одобрение точной версии",
    text: "Комментарии и решение относятся к конкретной версии. Изменённый текст требует новой проверки.",
  },
  {
    icon: <Send aria-hidden="true" />,
    title: "Подтверждённая публикация",
    text: "Telegram публикуется с сервера, а статус операции и безопасный повтор сохраняются в проекте.",
  },
];

const steps = [
  {
    icon: <Radar aria-hidden="true" />,
    title: "Находит сигнал",
    text: "Проверяет выбранные каналы и открытые источники в вашей нише.",
  },
  {
    icon: <Gauge aria-hidden="true" />,
    title: "Сравнивает честно",
    text: "Считает результат относительно привычного уровня каждого канала.",
  },
  {
    icon: <Sparkles aria-hidden="true" />,
    title: "Готовит ваш угол",
    text: "Переносит механику, но не чужие фразы, факты и позицию.",
  },
  {
    icon: <ShieldCheck aria-hidden="true" />,
    title: "Даёт контроль",
    text: "Показывает доказательства, ограничения и точную версию на одобрение.",
  },
  {
    icon: <RotateCcw aria-hidden="true" />,
    title: "Сохраняет результат",
    text: "Публикует после решения и возвращает результат в аналитику проекта.",
  },
];

const comparisonRows = [
  {
    criterion: "Главный вопрос",
    scheduler: "Когда и куда поставить пост?",
    analytics: "Что уже произошло?",
    generator: "Как быстро написать текст?",
    aurora: "Что стоит публиковать дальше — и почему?",
  },
  {
    criterion: "Точка старта",
    scheduler: "Готовая идея пользователя",
    analytics: "Таблица метрик",
    generator: "Промпт",
    aurora: "Проверенный пост выше нормы канала",
  },
  {
    criterion: "Связь с источником",
    scheduler: "Не обязательна",
    analytics: "Источник есть, действия нет",
    generator: "Обычно не видна",
    aurora: "Источник → причина → новый угол → черновик",
  },
  {
    criterion: "Контроль смысла",
    scheduler: "Редакторская проверка",
    analytics: "Не относится к тексту",
    generator: "Зависит от промпта",
    aurora: "Факты, история, версия и ручное одобрение",
  },
  {
    criterion: "Результат",
    scheduler: "Опубликованный пост",
    analytics: "Отчёт",
    generator: "Черновик",
    aurora: "Обоснованный материал и подтверждённая публикация",
  },
] as const;

const accessCards = [
  {
    status: "Работает",
    title: "Радар и тренды",
    note: "Проверенные Telegram-источники, норма канала и объяснение найденного сигнала.",
    features: ["Поиск по своей нише", "Ссылка на исходный пост", "Черновик из найденной возможности"],
  },
  {
    status: "Доступно",
    title: "Редактор и контроль",
    note: "Голос канала, настройки качества, доказательства, версии и согласование.",
    features: ["Сравнение с историей канала", "Карточки источников", "Ручное подтверждение версии"],
  },
  {
    status: "Работает",
    title: "Telegram-публикация",
    note: "Календарь, серверная отправка и состояние каждой операции.",
    features: ["Публикация по расписанию", "Статусы и история", "Повтор без дублирования частей"],
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
            <a href="#difference">Отличие</a>
            <a href="#how">Как работает</a>
            <a href="#control">Контроль</a>
            <a href="#features">Возможности</a>
            <a href="#access">Доступ</a>
          </nav>
          <div className={styles.headerActions}>
            <a className={styles.loginLink} href="/login">Войти</a>
            <a className={styles.primaryButton} href="/register">Попробовать Аврору</a>
          </div>
          <LandingMobileNav />
        </div>
      </header>

      <main id="main">
        <section className={`${styles.hero} ${styles.heroReframed}`} id="top" aria-labelledby="hero-title">
          <div className={styles.heroGrid} aria-hidden="true" />
          <div className={styles.heroBeam} aria-hidden="true" />
          <div className={`${styles.heroInner} ${styles.heroInnerReframed}`}>
            <div className={`${styles.heroCopy} ${styles.heroCopyReframed}`}>
              <p className={`${styles.eyebrow} ${styles.heroEyebrow}`}>Content Intelligence для Telegram</p>
              <h1 id="hero-title">
                Сначала{" "}<br />
                <span>доказательство.</span>{" "}<br />
                Потом контент.
              </h1>
              <p className={styles.heroLead}>
                Аврора находит посты, которые сработали <strong>выше нормы своего канала</strong>,
                объясняет почему и готовит ваш оригинальный материал — с источниками, контролем
                версии и публикацией после одобрения.
              </p>
              <div className={styles.heroActions}>
                <a className={styles.primaryButtonLarge} href="/register">
                  Найти сигнал в моей нише
                  <ArrowRight aria-hidden="true" />
                </a>
                <a className={styles.heroTextLink} href="#difference">
                  Почему это не автопостинг
                </a>
              </div>
              <ul className={styles.heroBenefits} aria-label="Главные отличия Авроры">
                <li><Check aria-hidden="true" />Источник виден</li>
                <li><Check aria-hidden="true" />Новый угол вместо копии</li>
                <li><Check aria-hidden="true" />Без одобрения не публикует</li>
              </ul>
            </div>
            <EvidenceEngine />
          </div>
        </section>

        <section className={`${styles.trustBar} ${styles.outcomeBar}`} aria-label="Цикл Авроры">
          <div className={styles.outcomeTrack}>
            <span><b>01</b>Сигнал</span><i aria-hidden="true" />
            <span><b>02</b>Причина</span><i aria-hidden="true" />
            <span><b>03</b>Ваш материал</span><i aria-hidden="true" />
            <span><b>04</b>Контроль</span><i aria-hidden="true" />
            <span><b>05</b>Публикация</span>
          </div>
        </section>

        <section className={`${styles.section} ${styles.differenceSection}`} id="difference" aria-labelledby="difference-title">
          <div className={styles.container}>
            <SectionHeading
              id="difference-title"
              eyebrow="Почему Аврора"
              title="Не лучше во всём. Сильнее в главном переходе."
              description="Планировщики доставляют готовый контент. Аналитика показывает прошлое. Обычный AI пишет по запросу. Аврора соединяет наблюдаемый сигнал с контролируемым действием."
            />

            <div className={styles.comparisonCallout}>
              <div><span>Рыночный разрыв</span><strong>От «это залетело» до «вот что публиковать нам»</strong></div>
              <p>Один непрерывный маршрут — без таблиц, копипаста и прыжков между пятью сервисами.</p>
            </div>

            <div className={styles.comparisonScroll} tabIndex={0} aria-describedby="comparison-hint">
              <table className={styles.comparisonTable}>
                <caption className="sr-only">Сравнение Авроры с основными категориями SMM-инструментов</caption>
                <thead>
                  <tr>
                    <th scope="col">Критерий</th>
                    <th scope="col">Автопостинг</th>
                    <th scope="col">Аналитика</th>
                    <th scope="col">AI-генератор</th>
                    <th scope="col" className={styles.auroraColumn}><Logo size={22} decorative />Аврора</th>
                  </tr>
                </thead>
                <tbody>
                  {comparisonRows.map((row) => (
                    <tr key={row.criterion}>
                      <th scope="row">{row.criterion}</th>
                      <td>{row.scheduler}</td>
                      <td>{row.analytics}</td>
                      <td>{row.generator}</td>
                      <td className={styles.auroraColumn}><Check aria-hidden="true" />{row.aurora}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={styles.comparisonHint} id="comparison-hint">На узком экране таблицу можно прокрутить по горизонтали.</p>
          </div>
        </section>

        <section className={`${styles.section} ${styles.processSection}`} id="how" aria-labelledby="how-title">
          <div className={styles.container}>
            <SectionHeading
              id="how-title"
              eyebrow="Замкнутый цикл"
              title="От чужого сигнала — к вашему решению"
              description="Аврора не переносит чужой текст. Она сохраняет доказательство, выделяет рабочую механику и строит новую версию вокруг вашего голоса и фактов."
            />
            <ol className={`${styles.steps} ${styles.cycleSteps}`}>
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

        <section className={`${styles.analyticsSection} ${styles.controlSection}`} id="control" aria-labelledby="control-title">
          <div className={`${styles.container} ${styles.analyticsShell} ${styles.controlShell}`}>
            <div className={styles.analyticsIntro}>
              <p className={styles.eyebrow}>Доверие по умолчанию</p>
              <h2 id="control-title">Можно открыть любой вывод и понять, откуда он взялся</h2>
              <p>
                Для экспертного контента скорость без прозрачности опасна. Поэтому источник,
                наблюдаемые цифры, использованные факты и решение редактора остаются рядом с материалом.
              </p>
              <ul className={styles.analyticsList}>
                <li><Check aria-hidden="true" />Ссылка на исходный пост</li>
                <li><Check aria-hidden="true" />Сравнение с нормой канала</li>
                <li><Check aria-hidden="true" />Факты и дата актуальности</li>
                <li><Check aria-hidden="true" />История точной версии</li>
              </ul>
              <a className={styles.secondaryButton} href="/register">
                Проверить свою тему
                <ArrowRight aria-hidden="true" />
              </a>
            </div>

            <div className={`${styles.dashboard} ${styles.proofDashboard}`} aria-label="Демонстрация цепочки доказательств">
              <div className={styles.proofDashboardHeader}>
                <div><span>Evidence trail · #A-2408</span><strong>Почему этот материал появился в плане</strong></div>
                <span><ShieldCheck aria-hidden="true" />Всё можно проверить</span>
              </div>
              <div className={styles.proofChain}>
                <article>
                  <span><Radar aria-hidden="true" />Наблюдение</span>
                  <strong>×2,7 к медиане источника</strong>
                  <p>Не абсолютная популярность, а отклонение от привычного результата канала.</p>
                </article>
                <ArrowRight aria-hidden="true" />
                <article>
                  <span><BarChart3 aria-hidden="true" />Гипотеза</span>
                  <strong>Сработала конкретика риска</strong>
                  <p>Аврора переносит механику, но создаёт новый пример и структуру.</p>
                </article>
                <ArrowRight aria-hidden="true" />
                <article>
                  <span><FileCheck2 aria-hidden="true" />Решение</span>
                  <strong>Версия 3 одобрена</strong>
                  <p>Опубликована именно проверенная версия. История правок сохранена.</p>
                </article>
              </div>
              <div className={styles.proofFooter}>
                <span><History aria-hidden="true" />Источник · факты · версия · операция публикации</span>
                <b>Цепочка не потеряна</b>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.socialSection} aria-labelledby="focus-title">
          <div className={styles.container}>
            <p className={styles.eyebrow} id="focus-title">Осознанный фокус</p>
            <div className={styles.socialList}>
              <span><i className={styles.telegramIcon}>➤</i><span className={styles.socialCopy}><strong>Telegram</strong><small>разведка и публикация работают</small></span></span>
              <span><i className={styles.vkIcon}>VK</i><span className={styles.socialCopy}><strong>ВКонтакте</strong><small>подключается после настройки приложения</small></span></span>
              <span><ShieldCheck aria-hidden="true" /><span className={styles.socialCopy}><strong>Не 30 сетей ради цифры</strong><small>сначала глубина решения для Telegram и VK</small></span></span>
            </div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.reviewsSection}`} id="features" aria-labelledby="features-title">
          <div className={styles.container}>
            <SectionHeading
              id="features-title"
              eyebrow="Продуктовый ров"
              title="То, что сложнее скопировать, чем кнопку «Написать AI»"
              description="Ценность не в одной модели. Она в накопленной связи между источниками, решениями, голосом канала и результатами публикаций."
            />
            <div className={styles.featureGrid}>
              {features.map((feature) => (
                <article className={styles.featureCard} key={feature.title}>
                  <span className={styles.featureIcon}>{feature.icon}</span>
                  <div><h3>{feature.title}</h3><p>{feature.text}</p></div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.pricingSection}`} id="access" aria-labelledby="access-title">
          <div className={styles.container}>
            <SectionHeading
              id="access-title"
              eyebrow="Что доступно сейчас"
              title="Не концепт. Рабочие контуры продукта."
              description="Показываем только то, что уже существует в «Авроре», а готовность конкретного подключения проверяем внутри проекта."
            />
            <div className={`${styles.pricingGrid} ${styles.accessGrid}`}>
              {accessCards.map((card) => (
                <article className={`${styles.priceCard} ${styles.accessCard}`} key={card.title}>
                  <span className={styles.accessStatus}>{card.status}</span>
                  <h3>{card.title}</h3>
                  <p className={styles.planNote}>{card.note}</p>
                  <ul>{card.features.map((feature) => <li key={feature}><Check aria-hidden="true" />{feature}</li>)}</ul>
                </article>
              ))}
            </div>
            <div className={styles.accessAction}>
              <a className={styles.secondaryButton} href="/register">Создать проект<ArrowRight aria-hidden="true" /></a>
              <p>Начните с канала, темы и трёх конкурентов. Остальное Аврора покажет по шагам.</p>
            </div>
          </div>
        </section>

        <section className={styles.ctaSection} aria-labelledby="cta-title">
          <div className={`${styles.container} ${styles.ctaCard} ${styles.ctaCardReframed}`}>
            <div className={styles.ctaMark} aria-hidden="true"><Logo size={68} decorative /></div>
            <div className={styles.ctaCopy}>
              <p className={styles.ctaEyebrow}>Первый результат</p>
              <h2 id="cta-title">Не просите AI придумать тему. Дайте Авроре её доказать.</h2>
              <p>Подключите канал, укажите нишу и получите первый обоснованный черновик.</p>
            </div>
            <a className={styles.whiteButton} href="/register">Найти первый сигнал<ArrowRight aria-hidden="true" /></a>
            <div className={styles.ctaOrbit} aria-hidden="true"><span>✦</span></div>
          </div>
        </section>
      </main>

      <footer className={styles.footer} id="footer">
        <div className={styles.footerInner}>
          <div className={styles.footerBrand}>
            <BrandLockup />
            <p>Evidence-driven Content Intelligence для Telegram и VK.</p>
            <small>© 2026 Аврора. Все права защищены.</small>
          </div>
          <div className={styles.footerLinks}>
            <div><strong>Продукт</strong><a href="#difference">Отличие</a><a href="#how">Как работает</a><a href="#features">Возможности</a></div>
            <div><strong>Контроль</strong><a href="#control">Цепочка доказательств</a><a href="#access">Доступность</a></div>
            <div><strong>Связь</strong><a href="mailto:hello@avrora.app">Контакты</a><a href="mailto:help@avrora.app">Сообщить об ошибке</a></div>
            <div><strong>Документы</strong><a href="mailto:legal@avrora.app?subject=Пользовательское%20соглашение">Пользовательское соглашение</a><a href="mailto:legal@avrora.app?subject=Политика%20конфиденциальности">Конфиденциальность</a></div>
          </div>
          <div className={styles.footerSocial}>
            <strong>Фокус</strong>
            <p>Telegram — работает<br />VK — после настройки</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
