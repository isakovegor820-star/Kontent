import { ArrowRight, Check, Clock3 } from "lucide-react";
import { PRODUCT_TAGLINE } from "@/lib/product";
import styles from "./bento.module.css";
import { HERO_EVIDENCE_CHECKS, HERO_TILES, HERO_WEEK } from "./content";

/**
 * Первый экран: обещание и мозаика из пяти плиток.
 *
 * Порядок и содержание — из утверждённого макета владельца
 * (`docs/design-refs/aurora-bento.html`). Заголовок оставлен одним текстовым узлом
 * (`PRODUCT_TAGLINE`): акцентная строка сделана через `::first-line`, поэтому
 * заголовок целиком читают и тест главной, и генеративный движок.
 *
 * Мозаика — не картинка и не украшение: каждая плитка показывает то, о чём говорит
 * текст рядом, и все они настоящие (источник, дата, версия, расписание).
 */

const CHIPS = [
  { label: "Telegram — работает", color: "#25c9e8" },
  { label: "VK — после настройки", color: "#5a3cf0" },
  { label: "Решение — за юристом", color: "#28d19a" },
] as const;

/** Содержимое плитки зависит от её смысла: календарь, чек-лист, версии, полоса. */
function TileBody({ id }: { id: string }) {
  if (id === "plan") {
    return (
      <>
        <div className={styles.mini}>
          {HERO_WEEK.map((day) => (
            <b key={day.day}>
              <span>{day.day}</span>
              <em className={day.tone ? styles[day.tone] : undefined}>{day.status}</em>
            </b>
          ))}
        </div>
        <div className={styles.pbar} aria-hidden="true">
          <i />
        </div>
      </>
    );
  }

  if (id === "evidence") {
    return (
      <ul className={styles.check}>
        {HERO_EVIDENCE_CHECKS.map((item, index) => (
          <li key={item}>
            {index === 2 ? <Clock3 aria-hidden="true" /> : <Check aria-hidden="true" />}
            {item}
          </li>
        ))}
      </ul>
    );
  }

  if (id === "risk") {
    return (
      <>
        <div className={styles.big} aria-hidden="true">
          ✓
        </div>
        <div className={styles.bigLabel}>Риск отмечен до публикации</div>
      </>
    );
  }

  if (id === "versions") {
    return (
      <div className={styles.vers}>
        <b>v.01</b>
        <i aria-hidden="true">→</i>
        <b>v.02</b>
        <i aria-hidden="true">→</i>
        <b className={styles.now}>v.03</b>
      </div>
    );
  }

  return null;
}

export function Hero() {
  return (
    <section className={`${styles.wrap} ${styles.hero}`} id="top" aria-labelledby="hero-title">
      <span className={`${styles.pill} ${styles.enter}`} style={{ "--delay": "0ms" } as React.CSSProperties}>
        <i aria-hidden="true" />
        Контент-платформа для юридических практик
      </span>

      <h1 className={`${styles.heroTitle} ${styles.enter}`} id="hero-title" style={{ "--delay": "60ms" } as React.CSSProperties}>
        {PRODUCT_TAGLINE}
      </h1>

      <p className={`${styles.lede} ${styles.enter}`} style={{ "--delay": "140ms" } as React.CSSProperties}>
        Аврора превращает подготовку постов в проверяемый процесс: контент-план,
        доказательства к каждому утверждению, версии и согласование — и публикация в Telegram.
      </p>

      <div className={`${styles.heroCta} ${styles.enter}`} style={{ "--delay": "220ms" } as React.CSSProperties}>
        <a className={`${styles.btn} ${styles.btnGrape}`} href="/register">
          Создать первый материал
          <ArrowRight aria-hidden="true" />
        </a>
        <a className={`${styles.btn} ${styles.btnGhost}`} href="#how">
          Как это работает
        </a>
      </div>

      <div className={`${styles.heroChips} ${styles.enter}`} style={{ "--delay": "300ms" } as React.CSSProperties}>
        {CHIPS.map((chip) => (
          <span className={styles.chip} key={chip.label}>
            <i style={{ background: chip.color }} aria-hidden="true" />
            {chip.label}
          </span>
        ))}
      </div>

      <div className={`${styles.bento} ${styles.heroBento} ${styles.enter}`} style={{ "--delay": "380ms" } as React.CSSProperties}>
        {HERO_TILES.map((tile) => {
          const Icon = tile.icon;
          const span = styles[`s${tile.span}` as keyof typeof styles];
          const tone = styles[tile.tone];
          return (
            <div
              className={`${styles.tile} ${tone} ${span} ${tile.tall ? styles.r2 : ""}`}
              data-hero-tile={tile.id}
              key={tile.id}
            >
              {Icon ? (
                <div className={styles.ico}>
                  <Icon aria-hidden="true" strokeWidth={2.2} />
                </div>
              ) : null}
              {tile.id === "risk" ? null : <h3>{tile.title}</h3>}
              {tile.text ? <p>{tile.text}</p> : null}
              <TileBody id={tile.id} />
              {tile.tag ? <span className={styles.tag}>{tile.tag}</span> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
