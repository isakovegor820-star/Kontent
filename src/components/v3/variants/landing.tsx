import Link from "next/link";
import { ArrowRight, Check, LogIn } from "lucide-react";
import { V3Faq } from "@/components/v3/faq";
import { V3KineticHow } from "@/components/v3/how-variants/how-variants";
import {
  V3AnimatedFooter,
  type FooterInteractionVariant,
  type FooterVariant,
} from "@/components/v3/footer-variants";
import { V3FinalCta, V3Footer } from "@/components/v3/final-cta";
import { V3DemoPanel } from "@/components/v3/hero";
import { V3Ledger } from "@/components/v3/ledger";
import { V3GravityMemoryManifest } from "@/components/v3/memory-variants/memory-variants";
import { V3PostProof } from "@/components/v3/post-proof";
import { V3ProductionFooter } from "@/components/v3/production-footer";
import { V3ProductionStory } from "@/components/v3/production-story";
import { V3QualityVerdict } from "@/components/v3/quality-verdict";
import {
  V3ScrollFinale,
  type ScrollFinaleVariant,
} from "@/components/v3/scroll-finale";
import { V3ScrollMotion } from "@/components/v3/scroll-motion";
import { V3StickyCta } from "@/components/v3/sticky-cta";
import { V3Ticker } from "@/components/v3/ticker";
import { ReasonsSwitcher } from "@/components/v3/reasons-switcher";
import {
  ReasonsVariants,
  type ReasonsVariant,
} from "@/components/v3/reasons-variants";
import { EditorialConveyor } from "./editorial-conveyor";
import { VariantSwitcher } from "./variant-switcher";

type Variant = 1 | 2 | 3 | 4;

const NAV_LINKS = [
  { href: "#how", label: "Как это работает" },
  { href: "#memory", label: "Голос и факты" },
  { href: "#quality", label: "Контроль качества" },
  { href: "#faq", label: "Вопросы" },
] as const;

const PRODUCT_LINKS = [
  { href: "#how", label: "Разведка" },
  { href: "#how", label: "ИИ-редактор" },
  { href: "#how", label: "Автопостинг" },
  { href: "#quality", label: "Контроль" },
] as const;

const FACTS = [
  { value: "8", caption: "сервисов протестировали руками" },
  { value: "2–3 ч", caption: "цикл разведки конкурентов" },
  { value: "15 мин", caption: "в неделю занимает контроль" },
  { value: "3", caption: "способа наполнить память" },
] as const;

const AURORA_ASSURANCES = [
  {
    value: "Работает",
    caption: "Telegram-контур доступен уже сейчас",
  },
  {
    value: "С сервера",
    caption: "публикация не зависит от ноутбука",
  },
  {
    value: "До выпуска",
    caption: "проверяются факты, тон и правила",
  },
  {
    value: "У тебя",
    caption: "пауза, правки и последнее слово",
  },
] as const;

function Brand() {
  return (
    <Link href="/" className="av-brand" aria-label="Аврора, текущая главная">
      <span className="av-brand__mark" aria-hidden>
        А
      </span>
      <span className="av-brand__word">Аврора</span>
    </Link>
  );
}

function PrimaryCta({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/register" className={`v3-btn ${compact ? "v3-btn--sm" : "v3-btn--lg"}`}>
      Забрать ранний доступ
      <ArrowRight className="h-4 w-4" strokeWidth={2.5} aria-hidden />
    </Link>
  );
}

function HeroCopy({ titleId, compact = false }: { titleId: string; compact?: boolean }) {
  return (
    <div className="av-copy">
      <p className="av-kicker">Автопилот для Telegram-каналов</p>
      <h1 id={titleId} className={`av-title ${compact ? "av-title--compact" : ""}`}>
        Канал
        <span>ведётся</span>
        <mark>сам.</mark>
      </h1>
      <p className="av-lead">
        Платформа следит за конкурентами, находит залетающие темы, пишет посты твоим голосом и
        публикует их в Telegram по расписанию, с сервера.
      </p>
      <div className="av-actions">
        <PrimaryCta />
        <a href="#how" className="v3-btn v3-btn--ghost v3-btn--lg">
          Как это работает
        </a>
      </div>
      <p className="av-proofline">
        <span>Бесплатно на старте</span>
        <span>Без карты</span>
        <span>Telegram публикует уже сейчас</span>
      </p>
    </div>
  );
}

function MetricRail({ className = "" }: { className?: string }) {
  return (
    <dl className={`av-metrics ${className}`.trim()}>
      {FACTS.map((fact) => (
        <div className="av-metric" key={fact.caption}>
          <dt>{fact.caption}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function VariantOneNav() {
  return (
    <header className="av-nav av1-nav">
      <div className="av-container av1-nav__inner">
        <Brand />
        <nav className="av1-nav__links" aria-label="Разделы варианта 1">
          {NAV_LINKS.map((link) => (
            <a href={link.href} key={link.href}>
              {link.label}
            </a>
          ))}
        </nav>
        <PrimaryCta compact />
      </div>
    </header>
  );
}

function VariantTwoNav() {
  return (
    <header className="av-nav av2-nav">
      <div className="av-container av2-nav__inner">
        <Brand />
        <p>Редакция работает, пока ты занят каналом</p>
        <PrimaryCta compact />
      </div>
    </header>
  );
}

function VariantThreeNav() {
  return (
    <header className="av-nav av3-nav">
      <div className="av-container av3-nav__inner">
        <Brand />
        <nav className="av3-product-tabs" aria-label="Функции продукта">
          {PRODUCT_LINKS.map((link) => (
            <a href={link.href} key={link.label}>
              {link.label}
            </a>
          ))}
        </nav>
        <Link href="/register" className="av-login">
          <LogIn className="h-4 w-4" strokeWidth={2.5} aria-hidden />
          Войти
        </Link>
      </div>
    </header>
  );
}

function VariantFourNav() {
  return (
    <header className="av-nav av4-nav">
      <div className="av-container av4-nav__inner">
        <Brand />
        <nav className="av4-nav__links" aria-label="Разделы варианта 4">
          {NAV_LINKS.map((link) => (
            <a href={link.href} key={link.href}>
              {link.label}
            </a>
          ))}
        </nav>
        <Link href="/register" className="v3-btn v3-btn--sm av4-nav__cta">
          Запустить Аврору
          <ArrowRight className="h-4 w-4" strokeWidth={2.5} aria-hidden />
        </Link>
      </div>
    </header>
  );
}

function VariantOneHero() {
  return (
    <section className="av1-hero" aria-labelledby="av1-title">
      <div className="av-container av1-grid">
        <HeroCopy titleId="av1-title" />
        <div className="av1-demo">
          <V3DemoPanel />
        </div>
        <MetricRail className="av1-metrics" />
      </div>
    </section>
  );
}

function VariantTwoHero() {
  return (
    <section className="av2-hero" aria-labelledby="av2-title">
      <div className="av-container av2-grid">
        <nav className="av2-index" aria-label="Разделы варианта 2">
          <span>Меню</span>
          {NAV_LINKS.map((link) => (
            <a href={link.href} key={link.href}>
              {link.label}
            </a>
          ))}
        </nav>

        <div className="av2-headline">
          <p className="av-kicker">Автопилот для Telegram-каналов</p>
          <h1 id="av2-title" className="av2-title">
            Канал ведётся <mark>сам.</mark>
          </h1>
        </div>

        <div className="av2-copy">
          <p className="av-lead">
            Платформа следит за конкурентами, находит залетающие темы, пишет посты твоим голосом и
            публикует их в Telegram по расписанию, с сервера.
          </p>
          <div className="av-actions">
            <PrimaryCta />
            <a href="#how" className="av-text-link">
              Посмотреть механику
              <ArrowRight className="h-4 w-4" strokeWidth={2.5} aria-hidden />
            </a>
          </div>
          <p className="av-proofline">
            <span>Бесплатно на старте</span>
            <span>Без карты</span>
          </p>
        </div>

        <div className="av2-demo">
          <V3DemoPanel />
        </div>

        <MetricRail className="av2-metrics" />
      </div>
    </section>
  );
}

const WORKFLOW = ["Запрос", "Черновик", "Публикация"] as const;

function VariantThreeHero() {
  return (
    <section className="av3-hero" aria-labelledby="av3-title">
      <div className="av-container">
        <div className="av3-intro">
          <div>
            <p className="av-kicker">Автопилот для Telegram-каналов</p>
            <h1 id="av3-title" className="av3-title">
              Канал ведётся <mark>сам.</mark>
            </h1>
          </div>
          <p className="av-lead">
            Разведка конкурентов, посты твоим голосом и публикация с сервера. Ты подтверждаешь
            готовое, Аврора ведёт процесс дальше.
          </p>
        </div>

        <div className="av3-workbench">
          <div className="av3-workflow" aria-label="Сценарий работы">
            {WORKFLOW.map((step, index) => (
              <div className="av3-workflow__step" key={step}>
                <span>{index + 1}</span>
                <strong>{step}</strong>
                <Check className="h-4 w-4" strokeWidth={3} aria-hidden />
              </div>
            ))}
            <Link href="/register" className="av3-workflow__cta">
              Запустить свой канал
              <ArrowRight className="h-4 w-4" strokeWidth={2.5} aria-hidden />
            </Link>
          </div>

          <div className="av3-product-grid">
            <div className="av3-demo">
              <V3DemoPanel />
            </div>
            <aside className="av3-side" aria-label="Ключевые показатели">
              <MetricRail className="av3-metrics" />
              <p className="av3-side__note">
                Бесплатно на старте. Без карты. Telegram публикует уже сейчас.
              </p>
            </aside>
          </div>
        </div>
      </div>
    </section>
  );
}

function VariantFourHero() {
  return (
    <section className="av4-hero" aria-labelledby="av4-title">
      <div className="av-container">
        <div className="av4-headline">
          <p>Автопилот для экспертов и Telegram-авторов</p>
          <h1 id="av4-title">
            <span>Канал ведётся,</span>
            <span>даже когда</span>
            <mark>ты занят.</mark>
          </h1>
        </div>

        <div className="av4-stage">
          <div className="av4-copy">
            <p className="av4-lead">
              Аврора находит сильные темы, пишет посты в твоём голосе, проверяет и публикует по
              расписанию. Правила и последнее слово остаются за тобой.
            </p>
            <div className="av4-actions">
              <Link href="/register" className="v3-btn v3-btn--lg av4-primary-cta">
                Запустить первый цикл
                <ArrowRight className="h-4 w-4" strokeWidth={2.5} aria-hidden />
              </Link>
              <a href="#how" className="av4-secondary-link">
                Посмотреть полный цикл
                <ArrowRight className="h-4 w-4" strokeWidth={2.5} aria-hidden />
              </a>
            </div>
            <p className="av4-next-step">Почта и пароль. Канал подключишь следующим шагом.</p>
            <p className="av4-proof">
              <span>Продукт работает сейчас</span>
              <span>Подтверждение можно оставить</span>
              <span>Пауза в любой момент</span>
            </p>
          </div>

          <EditorialConveyor />
        </div>

        <dl className="av4-assurances">
          {AURORA_ASSURANCES.map((item) => (
            <div key={item.value}>
              <dt>{item.value}</dt>
              <dd>{item.caption}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function VariantNav({ variant }: { variant: Variant }) {
  if (variant === 1) {
    return <VariantOneNav />;
  }
  if (variant === 2) {
    return <VariantTwoNav />;
  }
  if (variant === 3) {
    return <VariantThreeNav />;
  }
  return <VariantFourNav />;
}

function VariantHero({ variant }: { variant: Variant }) {
  if (variant === 1) return <VariantOneHero />;
  if (variant === 2) return <VariantTwoHero />;
  if (variant === 3) return <VariantThreeHero />;
  return <VariantFourHero />;
}

export function VariantLanding({
  variant,
  showSwitcher = true,
  reasonsVariant,
  showReasonsSwitcher = false,
  footerVariant,
  showFooterSwitcher = false,
  footerInteractionVariant,
  showFooterInteractionSwitcher = false,
  enableScrollMotion = false,
  finaleVariant,
  showFinaleSwitcher = false,
  production = false,
}: {
  variant: Variant;
  showSwitcher?: boolean;
  reasonsVariant?: ReasonsVariant;
  showReasonsSwitcher?: boolean;
  footerVariant?: FooterVariant;
  showFooterSwitcher?: boolean;
  footerInteractionVariant?: FooterInteractionVariant;
  showFooterInteractionSwitcher?: boolean;
  enableScrollMotion?: boolean;
  finaleVariant?: ScrollFinaleVariant;
  showFinaleSwitcher?: boolean;
  production?: boolean;
}) {
  return (
    <div className={`aurora-variants aurora-variant-${variant}`}>
      <div className="v3-grain" aria-hidden />
      {enableScrollMotion && <V3ScrollMotion />}
      {showSwitcher && <VariantSwitcher active={variant} />}
      {reasonsVariant && showReasonsSwitcher && (
        <ReasonsSwitcher active={reasonsVariant} />
      )}
      <VariantNav variant={variant} />
      <main id="main">
        <VariantHero variant={variant} />
        {production ? (
          <V3ProductionStory />
        ) : (
          <>
            <V3Ticker />
            {reasonsVariant ? <ReasonsVariants variant={reasonsVariant} /> : <V3Ledger />}
          </>
        )}
        <V3KineticHow production />
        {!production && <V3PostProof />}
        <V3GravityMemoryManifest />
        <V3QualityVerdict />
        <V3Faq />
        {finaleVariant ? (
          <V3ScrollFinale variant={finaleVariant} showSwitcher={showFinaleSwitcher} />
        ) : (
          <V3FinalCta />
        )}
      </main>
      {footerVariant ? (
        <V3AnimatedFooter
          variant={footerVariant}
          showSwitcher={showFooterSwitcher}
          interactionVariant={footerInteractionVariant}
          showInteractionSwitcher={showFooterInteractionSwitcher}
        />
      ) : production ? (
        <V3ProductionFooter />
      ) : (
        <V3Footer />
      )}
      <V3StickyCta />
    </div>
  );
}
