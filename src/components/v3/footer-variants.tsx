import type { CSSProperties } from "react";
import Link from "next/link";
import { ArrowUpRight, Send } from "lucide-react";
import {
  V3KineticFooterLab,
  type FooterInteractionVariant,
} from "./kinetic-footer-lab";
import styles from "./footer-variants.module.css";

export type FooterVariant = 1 | 2 | 3;
export type { FooterInteractionVariant } from "./kinetic-footer-lab";

const LETTERS = [..."АВРОРА"] as const;
const FOOTER_LINKS = [
  { href: "#how", label: "Как работает" },
  { href: "#quality", label: "Контроль" },
  { href: "#memory", label: "Память" },
  { href: "#faq", label: "Вопросы" },
] as const;
const SUPPORT_TG = "https://t.me/kontenfkv_bot";

function FooterSwitcher({ active }: { active: FooterVariant }) {
  return (
    <nav className={styles.switcher} aria-label="Переключатель вариантов футера" data-temporary-switcher>
      <span>Футер</span>
      {([1, 2, 3] as const).map((variant) => (
        <Link
          key={variant}
          href={`/footer/${variant}#footer`}
          aria-current={variant === active ? "page" : undefined}
        >
          {variant}
        </Link>
      ))}
    </nav>
  );
}

function FooterMeta({ inverse = false }: { inverse?: boolean }) {
  return (
    <div className={`${styles.meta} ${inverse ? styles.metaInverse : ""}`}>
      <p className={styles.metaClaim}>Ты задаёшь тон. Аврора держит ритм.</p>
      <nav aria-label="Разделы лендинга" className={styles.metaNav}>
        {FOOTER_LINKS.map((link) => (
          <a key={link.href} href={link.href}>
            {link.label}
          </a>
        ))}
      </nav>
      <a href={SUPPORT_TG} className={styles.telegram}>
        <Send aria-hidden />
        @kontenfkv_bot
      </a>
      <p className={styles.copyright}>© 2026 · Сделано в России</p>
    </div>
  );
}

function PressFooter() {
  return (
    <footer id="footer" className={`${styles.footer} ${styles.press}`}>
      <div className={styles.pressTop}>
        <span>01 / Печатный станок</span>
        <p>Редакция не закрывается</p>
        <ArrowUpRight aria-hidden />
      </div>

      <div className={styles.pressStage} aria-label="Аврора">
        <span className={styles.pressCarriage} aria-hidden />
        <div className={styles.pressWord} aria-hidden>
          {LETTERS.map((letter, index) => (
            <span
              key={`${letter}-${index}`}
              style={{ "--letter-index": index } as CSSProperties}
            >
              {letter}
            </span>
          ))}
        </div>
        <p className={styles.pressCaption}>Имя, которое остаётся после последней строки</p>
      </div>

      <FooterMeta />
    </footer>
  );
}

function SignalFooter() {
  return (
    <footer id="footer" className={`${styles.footer} ${styles.signal}`}>
      <div className={styles.signalGrid} aria-hidden />
      <div className={styles.signalTop}>
        <span>02 / Сигнал в эфире</span>
        <span className={styles.signalStatus}><i /> Канал на связи</span>
      </div>

      <div className={styles.signalStage}>
        <p className={styles.signalEyebrow}>Из шума — в узнаваемый голос</p>
        <p className={styles.signalWord} data-text="АВРОРА" aria-label="Аврора">
          АВРОРА
        </p>
        <div className={styles.signalLine} aria-hidden>
          <span />
        </div>
        <p className={styles.signalCaption}>Твой канал продолжает говорить, даже когда ты молчишь.</p>
      </div>

      <FooterMeta inverse />
    </footer>
  );
}

function KineticFooter() {
  return (
    <footer id="footer" className={`${styles.footer} ${styles.kinetic}`}>
      <div className={styles.ticker} aria-hidden>
        <div>
          <span>АВРОРА · КАНАЛ В ДВИЖЕНИИ · </span>
          <span>АВРОРА · КАНАЛ В ДВИЖЕНИИ · </span>
          <span>АВРОРА · КАНАЛ В ДВИЖЕНИИ · </span>
          <span>АВРОРА · КАНАЛ В ДВИЖЕНИИ · </span>
        </div>
      </div>

      <div className={styles.kineticWord} aria-label="Аврора">
        {LETTERS.map((letter, index) => (
          <div key={`${letter}-${index}`} style={{ "--letter-index": index } as CSSProperties}>
            <span aria-hidden>{String(index + 1).padStart(2, "0")}</span>
            <strong aria-hidden>{letter}</strong>
            <i aria-hidden />
          </div>
        ))}
      </div>

      <div className={styles.kineticStatement}>
        <p>Не логотип в углу.</p>
        <strong>Главный герой финала.</strong>
      </div>

      <FooterMeta />
    </footer>
  );
}

export function V3AnimatedFooter({
  variant,
  showSwitcher = false,
  interactionVariant,
  showInteractionSwitcher = false,
}: {
  variant: FooterVariant;
  showSwitcher?: boolean;
  interactionVariant?: FooterInteractionVariant;
  showInteractionSwitcher?: boolean;
}) {
  return (
    <>
      {showSwitcher && <FooterSwitcher active={variant} />}
      {variant === 1 ? (
        <PressFooter />
      ) : variant === 2 ? (
        <SignalFooter />
      ) : interactionVariant ? (
        <V3KineticFooterLab
          variant={interactionVariant}
          showSwitcher={showInteractionSwitcher}
        />
      ) : (
        <KineticFooter />
      )}
    </>
  );
}
