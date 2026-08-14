import type { ReactNode } from "react";
import {
  ArrowRight,
  BarChart3,
  CalendarDays,
  Check,
  Clock3,
  Link2,
  MessagesSquare,
  Send,
  Sparkles,
  UsersRound,
  Zap,
} from "lucide-react";
import { Logo } from "@/components/brand";
import { HeroProductScene } from "./hero-product-scene";
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
    text: "Собирайте контент-план и выпускайте посты во все соцсети из одного окна.",
  },
  {
    icon: <Clock3 aria-hidden="true" />,
    title: "Единый календарь",
    text: "Видите всю неделю целиком, быстро находите пробелы и переносите публикации.",
  },
  {
    icon: <BarChart3 aria-hidden="true" />,
    title: "Аналитика и отчёты",
    text: "Сравнивайте охваты, вовлечённость и рост — без ручных таблиц.",
  },
  {
    icon: <UsersRound aria-hidden="true" />,
    title: "Командная работа",
    text: "Роли, правки и согласование остаются рядом с контентом, а не в десяти чатах.",
  },
  {
    icon: <MessagesSquare aria-hidden="true" />,
    title: "Управление сообщениями",
    text: "Комментарии и входящие собраны в едином понятном интерфейсе.",
  },
  {
    icon: <Zap aria-hidden="true" />,
    title: "Автоматизация",
    text: "Повторяющиеся задачи работают сами, а команда сохраняет контроль.",
  },
];

const steps = [
  {
    icon: <Link2 aria-hidden="true" />,
    title: "Подключите соцсети",
    text: "Добавьте аккаунты и пригласите команду.",
  },
  {
    icon: <CalendarDays aria-hidden="true" />,
    title: "Спланируйте контент",
    text: "Соберите неделю и согласуйте публикации.",
  },
  {
    icon: <Send aria-hidden="true" />,
    title: "Публикуйте и общайтесь",
    text: "Аврора выпустит посты и соберёт реакции.",
  },
  {
    icon: <BarChart3 aria-hidden="true" />,
    title: "Улучшайте результат",
    text: "Смотрите динамику и усиливайте то, что растёт.",
  },
];

const testimonials = [
  {
    quote:
      "Аврора убрала ежедневную рутину. Теперь команда видит весь контент, статусы и цифры в одном месте.",
    name: "Мария Иванова",
    role: "SMM-руководитель",
    initials: "МИ",
  },
  {
    quote:
      "Наконец планирование и аналитика не живут в разных сервисах. На отчёты уходит в три раза меньше времени.",
    name: "Алексей Смирнов",
    role: "Руководитель агентства",
    initials: "АС",
  },
  {
    quote:
      "Интерфейс понятен без обучения. Подключили пять проектов и уже в первую неделю ускорили выпуск контента.",
    name: "Екатерина Петрова",
    role: "Маркетолог",
    initials: "ЕП",
  },
];

const plans = [
  {
    name: "Базовый",
    price: "990 ₽",
    note: "Для старта и личных проектов",
    features: ["5 аккаунтов", "Планирование публикаций", "Базовая аналитика", "Поддержка в чате"],
  },
  {
    name: "Про",
    price: "2 490 ₽",
    note: "Для растущих команд",
    features: ["15 аккаунтов", "Расширенная аналитика", "Командная работа", "Управление сообщениями"],
    popular: true,
  },
  {
    name: "Бизнес",
    price: "4 990 ₽",
    note: "Для бизнеса и агентств",
    features: ["50 аккаунтов", "Всё из тарифа Про", "Автоматизация", "Персональный менеджер"],
  },
  {
    name: "Корпоративный",
    price: "Индивидуально",
    note: "Для крупных команд",
    features: ["Безлимит аккаунтов", "Индивидуальные решения", "Интеграции и API", "SLA и безопасность"],
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
      <a className={styles.skipLink} href="#main-content">
        Перейти к содержанию
      </a>

      <header className={styles.header}>
        <div className={styles.headerInner}>
          <a className={styles.brandLink} href="#top" aria-label="Аврора — на главную">
            <BrandLockup />
          </a>
          <nav className={styles.nav} aria-label="Основная навигация">
            <a href="#product">Продукт</a>
            <a href="#features">Возможности</a>
            <a href="#pricing">Тарифы</a>
            <a href="#reviews">Отзывы</a>
            <a href="#how">Как работает</a>
          </nav>
          <div className={styles.headerActions}>
            <a className={styles.loginLink} href="/login">
              Войти
            </a>
            <a className={styles.primaryButton} href="/register">
              Попробовать бесплатно
            </a>
          </div>
        </div>
      </header>

      <main id="main-content">
        <section className={styles.hero} id="top" aria-labelledby="hero-title">
          <div className={styles.heroGlow} aria-hidden="true" />
          <div className={styles.heroInner}>
            <div className={styles.heroCopy}>
              <p className={styles.eyebrow}>SMM-платформа нового поколения</p>
              <h1 id="hero-title">
                Аврора — ваш центр управления контентом и социальными сетями
              </h1>
              <p className={styles.heroLead}>
                Планируйте публикации, работайте с командой и понимайте результат —
                быстрее, спокойнее и в одном сервисе.
              </p>
              <div className={styles.heroActions}>
                <a className={styles.primaryButtonLarge} href="/register">
                  Попробовать бесплатно
                  <ArrowRight aria-hidden="true" />
                </a>
                <span className={styles.trialNote}>
                  <strong>14 дней бесплатно</strong>
                  Без привязки карты
                </span>
              </div>
              <ul className={styles.heroBenefits} aria-label="Преимущества">
                <li><Check aria-hidden="true" />Все соцсети в одном окне</li>
                <li><Check aria-hidden="true" />До 70% меньше рутины</li>
                <li><Check aria-hidden="true" />Поддержка 24/7</li>
              </ul>
            </div>
            <HeroProductScene />
          </div>
        </section>

        <section className={styles.trustBar} aria-label="Команды, которые выбирают Аврору">
          <div className={styles.brandMarquee}>
            <span>lamoda</span>
            <span>СБЕР</span>
            <span>WILDBERRIES</span>
            <span>ökko</span>
            <span>Альфа-Банк</span>
            <span>LEMONADE</span>
            <span>NETFLIX</span>
            <span>точка</span>
          </div>
        </section>

        <section className={styles.section} id="features" aria-labelledby="features-title">
          <div className={styles.container}>
            <SectionHeading
              id="features-title"
              eyebrow="Возможности"
              title="Всё необходимое для эффективного SMM"
              description="Один рабочий контур — от первой идеи до понятного отчёта."
            />
            <div className={styles.featureGrid}>
              {features.map((feature) => (
                <article className={styles.featureCard} key={feature.title}>
                  <span className={styles.featureIcon}>{feature.icon}</span>
                  <div>
                    <h3>{feature.title}</h3>
                    <p>{feature.text}</p>
                  </div>
                  <span className={styles.cardArrow} aria-hidden="true">↗</span>
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
              title="Просто. Удобно. Эффективно."
              description="Четыре шага — и ежедневная работа становится системой."
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

        <section className={styles.analyticsSection} id="product" aria-labelledby="analytics-title">
          <div className={`${styles.container} ${styles.analyticsShell}`}>
            <div className={styles.analyticsIntro}>
              <p className={styles.eyebrow}>Аналитика</p>
              <h2 id="analytics-title">Данные, которые помогают расти</h2>
              <p>
                Аврора собирает важные метрики и превращает их в ясную картину: что
                работает сейчас и куда двигаться дальше.
              </p>
              <ul className={styles.analyticsList}>
                <li><Check aria-hidden="true" />Охваты и показы</li>
                <li><Check aria-hidden="true" />Вовлечённость</li>
                <li><Check aria-hidden="true" />Рост подписчиков</li>
                <li><Check aria-hidden="true" />Лучшее время публикации</li>
                <li><Check aria-hidden="true" />Сравнение площадок</li>
              </ul>
              <a className={styles.secondaryButton} href="/register">
                Подробнее об аналитике
                <ArrowRight aria-hidden="true" />
              </a>
            </div>

            <div className={styles.dashboard}>
              <div className={styles.metricGrid}>
                <article><span>Охват</span><strong>124K</strong><small>+18%</small></article>
                <article><span>Вовлечённость</span><strong>12.6%</strong><small>+15%</small></article>
                <article><span>Подписчики</span><strong>+256</strong><small>+12%</small></article>
                <article><span>Публикации</span><strong>48</strong><small>+8%</small></article>
              </div>
              <div className={styles.chartGrid}>
                <article className={styles.lineChartCard}>
                  <div className={styles.chartHeader}>
                    <strong>Динамика показателей</strong>
                    <span><i />Охват <i />Вовлечённость</span>
                  </div>
                  <div className={styles.lineChart} aria-hidden="true">
                    <span className={`${styles.chartLine} ${styles.chartLineOne}`} />
                    <span className={`${styles.chartLine} ${styles.chartLineTwo}`} />
                    <div className={styles.chartLabels}><span>13 мая</span><span>15 мая</span><span>17 мая</span><span>19 мая</span></div>
                  </div>
                </article>
                <article className={styles.donutCard}>
                  <strong>Источники охвата</strong>
                  <div className={styles.donut} aria-hidden="true"><span>124K<small>охват</small></span></div>
                  <ul>
                    <li><i />Instagram <b>40%</b></li>
                    <li><i />Telegram <b>26%</b></li>
                    <li><i />VK <b>20%</b></li>
                    <li><i />YouTube <b>14%</b></li>
                  </ul>
                </article>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.socialSection} aria-labelledby="social-title">
          <div className={styles.container}>
            <p className={styles.eyebrow} id="social-title">Подключайте любимые соцсети</p>
            <div className={styles.socialList}>
              <span><i className={styles.instagramIcon}>◎</i>Instagram</span>
              <span><i className={styles.vkIcon}>VK</i>ВКонтакте</span>
              <span><i className={styles.telegramIcon}>➤</i>Telegram</span>
              <span><i className={styles.youtubeIcon}>▶</i>YouTube</span>
              <span><i className={styles.tiktokIcon}>♪</i>TikTok</span>
              <span><i className={styles.okIcon}>OK</i>Одноклассники</span>
              <span><Sparkles aria-hidden="true" />и ещё больше</span>
            </div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.reviewsSection}`} id="reviews" aria-labelledby="reviews-title">
          <div className={styles.container}>
            <SectionHeading
              id="reviews-title"
              eyebrow="Нас выбирают"
              title="Отзывы наших клиентов"
              description="Команды становятся быстрее, а контент — предсказуемее."
            />
            <div className={styles.reviewGrid}>
              {testimonials.map((testimonial) => (
                <article className={styles.reviewCard} key={testimonial.name}>
                  <div className={styles.stars} aria-label="Оценка 5 из 5">★★★★★</div>
                  <blockquote>«{testimonial.quote}»</blockquote>
                  <footer>
                    <span className={styles.avatar}>{testimonial.initials}</span>
                    <span><strong>{testimonial.name}</strong><small>{testimonial.role}</small></span>
                  </footer>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.pricingSection}`} id="pricing" aria-labelledby="pricing-title">
          <div className={styles.container}>
            <SectionHeading
              id="pricing-title"
              eyebrow="Тарифы"
              title="Выберите подходящий тариф"
              description="Начните бесплатно и меняйте план вместе с ростом команды."
            />
            <div className={styles.pricingGrid}>
              {plans.map((plan) => (
                <article className={`${styles.priceCard} ${plan.popular ? styles.priceCardPopular : ""}`} key={plan.name}>
                  {plan.popular ? <span className={styles.popularBadge}>Популярный</span> : null}
                  <h3>{plan.name}</h3>
                  <p className={styles.price}>{plan.price}<small>{plan.price.includes("₽") ? "/ месяц" : ""}</small></p>
                  <p className={styles.planNote}>{plan.note}</p>
                  <ul>
                    {plan.features.map((feature) => <li key={feature}><Check aria-hidden="true" />{feature}</li>)}
                  </ul>
                  <a className={plan.popular ? styles.primaryButton : styles.planButton} href="/register">
                    {plan.name === "Корпоративный" ? "Связаться с нами" : "Выбрать тариф"}
                  </a>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.ctaSection} aria-labelledby="cta-title">
          <div className={`${styles.container} ${styles.ctaCard}`}>
            <div className={styles.ctaMark} aria-hidden="true"><Logo size={68} decorative /></div>
            <div className={styles.ctaCopy}>
              <h2 id="cta-title">Готовы вывести ваш SMM на новый уровень?</h2>
              <p>Попробуйте Аврору бесплатно 14 дней и убедитесь сами.</p>
            </div>
            <a className={styles.whiteButton} href="/register">
              Начать бесплатно
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
            <p>SMM-платформа для управления контентом, командой и ростом.</p>
            <small>© 2026 Аврора. Все права защищены.</small>
          </div>
          <div className={styles.footerLinks}>
            <div><strong>Продукт</strong><a href="#features">Возможности</a><a href="#how">Как работает</a><a href="#pricing">Тарифы</a></div>
            <div><strong>Компания</strong><a href="#reviews">Отзывы</a><a href="mailto:hello@avrora.app">Контакты</a><a href="mailto:hello@avrora.app">Партнёрам</a></div>
            <div><strong>Поддержка</strong><a href="mailto:help@avrora.app">Помощь</a><a href="mailto:help@avrora.app">Обучение</a><a href="mailto:help@avrora.app">Статус системы</a></div>
            <div><strong>Документы</strong><a href="mailto:legal@avrora.app?subject=Пользовательское%20соглашение">Пользовательское соглашение</a><a href="mailto:legal@avrora.app?subject=Политика%20конфиденциальности">Конфиденциальность</a></div>
          </div>
          <div className={styles.footerSocial}>
            <strong>Мы в соцсетях</strong>
            <div aria-hidden="true"><span>➤</span><span>VK</span><span>▶</span></div>
          </div>
        </div>
      </footer>
    </div>
  );
}
