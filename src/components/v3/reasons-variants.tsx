"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { ArrowRight, Check, Clock3, Lightbulb, ScanSearch } from "lucide-react";
import { REASON_ROWS } from "./reasons-data";

export type ReasonsVariant = 1 | 2 | 3;

const REASON_ICONS = [Clock3, Lightbulb, ScanSearch] as const;
const REASON_ACTIONS = ["Планирует", "Находит", "Объясняет"] as const;

function VariantOne() {
  return (
    <section id="reasons" className="rv rv1" aria-labelledby="rv1-title">
      <div className="v3-wrap">
        <header className="rv1-header">
          <p className="v3-kicker v3-kicker--center justify-center">Знакомо?</p>
          <h2 id="rv1-title">Три причины, по которым каналы стоят</h2>
          <p>Каждую платформа закрывает не советом, а работой, которую берёт на себя.</p>
        </header>

        <ol className="rv1-list">
          {REASON_ROWS.map((row) => (
            <li className="rv1-row" key={row.pain}>
              <div className="rv1-before">
                <span>Было</span>
                <h3>{row.pain}</h3>
                <p>{row.painNote}</p>
              </div>
              <div className="rv1-arrow" aria-hidden>
                <ArrowRight strokeWidth={2.8} />
              </div>
              <div className="rv1-after">
                <span>{row.feature}</span>
                <h3>{row.solutionTitle}</h3>
                <p>{row.solution}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function VariantTwo() {
  const section = useRef<HTMLElement>(null);
  const [isInView, setIsInView] = useState(false);

  useEffect(() => {
    const node = section.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setIsInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setIsInView(true);
        observer.disconnect();
      },
      { threshold: 0.18 },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      ref={section}
      id="reasons"
      className={`rv rv2${isInView ? " rv2--animate" : ""}`}
      aria-labelledby="rv2-title"
    >
      <div className="v3-wrap">
        <header className="rv2-header">
          <div>
            <p>Канал тормозит в трёх местах</p>
            <h2 id="rv2-title">Три причины, по которым каналы стоят</h2>
          </div>
          <aside>
            <strong>Аврора берёт работу на себя</strong>
            <span>Не ещё один совет. Готовый следующий шаг.</span>
          </aside>
        </header>

        <ol className="rv2-stairs">
          {REASON_ROWS.map((row, index) => {
            return (
              <li
                className="rv2-step"
                key={row.pain}
                style={
                  {
                    "--rv-step": index,
                    "--rv-delay": `${index * 150}ms`,
                  } as CSSProperties
                }
              >
                <div className="rv2-step__pain">
                  <span>Было</span>
                  <s>{row.pain}</s>
                  <small>{row.painNote}</small>
                </div>
                <div
                  className="rv2-step__route"
                  data-route-action={REASON_ACTIONS[index]}
                >
                  <span className="rv2-step__route-line" aria-hidden />
                  <span className="rv2-step__signal" aria-hidden />
                  <span className="rv2-step__action">
                    {REASON_ACTIONS[index]}
                  </span>
                </div>
                <div className="rv2-step__result">
                  <span>{row.feature}</span>
                  <h3>{row.solutionTitle}</h3>
                  <p>{row.solution}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

function VariantThree() {
  const [active, setActive] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const row = REASON_ROWS[active];
  const ActiveIcon = REASON_ICONS[active];

  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const direction =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;

    if (!direction) return;
    event.preventDefault();
    const next = (index + direction + REASON_ROWS.length) % REASON_ROWS.length;
    setActive(next);
    queueMicrotask(() => tabs.current[next]?.focus());
  }

  return (
    <section id="reasons" className="rv rv3" aria-labelledby="rv3-title">
      <div className="v3-wrap">
        <header className="rv3-header">
          <p>Выбери, где канал застрял</p>
          <h2 id="rv3-title">Три причины, по которым каналы стоят</h2>
          <span>Посмотри, какую часть работы Аврора забирает себе.</span>
        </header>

        <div className="rv3-workbench">
          <div className="rv3-tabs" role="tablist" aria-label="Причины остановки канала">
            {REASON_ROWS.map((item, index) => (
              <button
                ref={(node) => {
                  tabs.current[index] = node;
                }}
                type="button"
                role="tab"
                id={`rv3-tab-${index}`}
                aria-controls="rv3-panel"
                aria-selected={active === index}
                tabIndex={active === index ? 0 : -1}
                onClick={() => setActive(index)}
                onKeyDown={(event) => moveTab(event, index)}
                key={item.pain}
              >
                <span>{item.pain}</span>
                <strong>{item.solutionTitle}</strong>
                <ArrowRight strokeWidth={2.6} aria-hidden />
              </button>
            ))}
          </div>

          <article
            id="rv3-panel"
            className="rv3-panel"
            role="tabpanel"
            aria-labelledby={`rv3-tab-${active}`}
            tabIndex={0}
          >
            <div className="rv3-panel__topline">
              <span>{row.feature}</span>
              <strong>Аврора работает</strong>
            </div>

            <div className="rv3-journey">
              <div className="rv3-journey__before">
                <span>Было</span>
                <s>{row.pain}</s>
                <p>{row.painNote}</p>
              </div>

              <div className="rv3-journey__action">
                <ActiveIcon strokeWidth={2.35} aria-hidden />
                <span>Аврора берёт следующий шаг</span>
                <ArrowRight strokeWidth={2.8} aria-hidden />
              </div>

              <div className="rv3-journey__after">
                <span>Стало</span>
                <h3>{row.solutionTitle}</h3>
                <p>{row.solution}</p>
              </div>
            </div>

            <footer>
              <Check strokeWidth={3} aria-hidden />
              <span>Ты задаёшь направление. Рутину закрывает платформа.</span>
            </footer>
          </article>
        </div>
      </div>
    </section>
  );
}

export function ReasonsVariants({ variant }: { variant: ReasonsVariant }) {
  if (variant === 1) return <VariantOne />;
  if (variant === 2) return <VariantTwo />;
  return <VariantThree />;
}
