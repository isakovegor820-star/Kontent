"use client";

import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Activity,
  ArrowRight,
  AtSign,
  BarChart3,
  CalendarCheck2,
  Check,
  Eye,
  Heart,
  MessageCircle,
  Radar,
  RefreshCw,
  Send,
  Sparkles,
  TrendingUp,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Logo } from "@/components/brand";
import { AirWave } from "@/components/landing/air-wave";
import styles from "./cycle-variants.module.css";

export type CycleVariant = 1 | 2 | 3 | 4 | 5;

type CycleStep = {
  id: string;
  num: string;
  name: string;
  verb: string;
  description: string;
  output: string;
  metric: string;
  Icon: LucideIcon;
};

const STEPS: CycleStep[] = [
  {
    id: "radar",
    num: "01",
    name: "Разведка",
    verb: "Находит темы до того, как они всем надоели",
    description:
      "Аврора сравнивает всплески у конкурентов, форматы и историю твоего канала. В работу попадает тема с понятной причиной роста.",
    output: "Тема + доказанный интерес",
    metric: "+38% к медиане",
    Icon: Radar,
  },
  {
    id: "content",
    num: "02",
    name: "ИИ-контент",
    verb: "Собирает пост в твоём голосе",
    description:
      "Факты, удачные форматы и редакционный профиль превращаются в готовый черновик. Без пустого шаблона и ручного промптинга.",
    output: "Черновик готов к проверке",
    metric: "40 секунд",
    Icon: Sparkles,
  },
  {
    id: "publish",
    num: "03",
    name: "Автопостинг",
    verb: "Выпускает точно по плану",
    description:
      "После подтверждения пост встаёт в календарь и выходит с сервера. Можно закрыть ноутбук — расписание продолжит работать.",
    output: "Пост вышел вовремя",
    metric: "7 дней вперёд",
    Icon: CalendarCheck2,
  },
  {
    id: "reaction",
    num: "04",
    name: "Реакции",
    verb: "Возвращает результат в новый цикл",
    description:
      "Охват, сохранения и вовлечение не остаются в отчёте. Аврора учитывает их, когда ищет следующую тему.",
    output: "Следующая идея уже точнее",
    metric: "+19% ER",
    Icon: BarChart3,
  },
];

const VARIANTS = [
  { id: 1, name: "Радар" },
  { id: 2, name: "Движок" },
  { id: 3, name: "Пост" },
  { id: 4, name: "Неделя" },
  { id: 5, name: "Рост" },
] as const;

const EASE = [0.22, 1, 0.36, 1] as const;

function useTabs() {
  const [active, setActive] = useState(0);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function register(index: number, node: HTMLButtonElement | null) {
    refs.current[index] = node;
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % 4;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index + 3) % 4;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = 3;
    else return;

    event.preventDefault();
    setActive(next);
    queueMicrotask(() => refs.current[next]?.focus());
  }

  return { active, setActive, register, onKeyDown };
}

function StageButton({
  index,
  active,
  prefix,
  panelId,
  register,
  onKeyDown,
  onActivate,
  className,
  children,
}: {
  index: number;
  active: number;
  prefix: string;
  panelId: string;
  register: (index: number, node: HTMLButtonElement | null) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, index: number) => void;
  onActivate: (index: number) => void;
  className?: string;
  children: ReactNode;
}) {
  const step = STEPS[index];
  return (
    <button
      ref={(node) => register(index, node)}
      type="button"
      role="tab"
      id={`${prefix}-${step.id}`}
      aria-controls={panelId}
      aria-selected={active === index}
      tabIndex={active === index ? 0 : -1}
      className={className}
      onClick={() => onActivate(index)}
      onKeyDown={(event) => onKeyDown(event, index)}
    >
      {children}
    </button>
  );
}

function Swap({ itemKey, children }: { itemKey: string; children: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={itemKey}
        initial={reduce ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduce ? undefined : { opacity: 0, y: -8 }}
        transition={{ duration: reduce ? 0 : 0.28, ease: EASE }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

function LabNav({ active }: { active: CycleVariant }) {
  return (
    <header className={styles.labNav}>
      <Link href="/" className={styles.brand} aria-label="Вернуться на главную Авроры">
        <Logo size={32} decorative />
        <span>Аврора</span>
      </Link>
      <p>Технологичные SMM-концепции</p>
      <nav aria-label="Варианты блока о цикле Авроры">
        {VARIANTS.map((item) => (
          <Link href={`/cycle/${item.id}`} aria-current={active === item.id ? "page" : undefined} key={item.id}>
            <span>0{item.id}</span>{item.name}
          </Link>
        ))}
      </nav>
    </header>
  );
}

function Eyebrow({ number, children }: { number: string; children: ReactNode }) {
  return <p className={styles.eyebrow}><span>{number}</span>{children}</p>;
}

function Cta() {
  return (
    <Link href="/register" className={styles.cta}>
      Запустить первый цикл <ArrowRight aria-hidden="true" />
    </Link>
  );
}

function StageDock({
  prefix,
  panelId,
  state,
}: {
  prefix: string;
  panelId: string;
  state: ReturnType<typeof useTabs>;
}) {
  return (
    <div className={styles.stageDock} role="tablist" aria-label="Этапы SMM-цикла Авроры">
      {STEPS.map((step, index) => (
        <StageButton
          key={step.id}
          index={index}
          active={state.active}
          prefix={prefix}
          panelId={panelId}
          register={state.register}
          onKeyDown={state.onKeyDown}
          onActivate={state.setActive}
        >
          <span>{step.num}</span>
          <step.Icon aria-hidden="true" />
          <strong>{step.name}</strong>
        </StageButton>
      ))}
    </div>
  );
}

function InfoPanel({
  step,
  id,
  labelledBy,
  className,
  headingLevel = "h2",
}: {
  step: CycleStep;
  id: string;
  labelledBy: string;
  className?: string;
  headingLevel?: "h2" | "h3";
}) {
  const Heading = headingLevel;
  return (
    <article id={id} role="tabpanel" aria-labelledby={labelledBy} className={className}>
      <Swap itemKey={step.id}>
        <p className={styles.panelKicker}>{step.num} / {step.name}</p>
        <Heading>{step.verb}</Heading>
        <p className={styles.panelText}>{step.description}</p>
        <div className={styles.panelResult}>
          <Check aria-hidden="true" />
          <span>{step.output}</span>
          <strong>{step.metric}</strong>
        </div>
      </Swap>
    </article>
  );
}

function RadarVariant() {
  const state = useTabs();
  const step = STEPS[state.active];
  return (
    <section className={`${styles.canvas} ${styles.radarPage}`} aria-labelledby="radar-title">
      <div className={styles.frame}>
        <Eyebrow number="01">Радар трендов</Eyebrow>
        <header className={styles.heroHead}>
          <h1 id="radar-title">Ловит момент.<br /><span>Не повторяет за всеми.</span></h1>
          <p>Аврора видит, где внимание аудитории только начинает расти, и проводит находку через весь SMM-цикл.</p>
        </header>

        <div className={styles.radarBoard}>
          <div className={styles.radarVisual} aria-hidden="true">
            <span className={styles.radarSweep} />
            <i className={styles.radarRing1} /><i className={styles.radarRing2} /><i className={styles.radarRing3} />
            <div className={`${styles.signal} ${styles.signal1}`}><TrendingUp />Карусели<strong>+38%</strong></div>
            <div className={`${styles.signal} ${styles.signal2}`}><Activity />Shorts<strong>+24%</strong></div>
            <div className={`${styles.signal} ${styles.signal3}`}><AtSign />Эксперты<strong>+17%</strong></div>
            <div className={styles.radarCore}><Logo size={46} decorative /><span>Сканирует</span></div>
          </div>
          <InfoPanel step={step} id="radar-panel" labelledBy={`radar-tab-${step.id}`} className={styles.infoPanel} />
        </div>
        <StageDock prefix="radar-tab" panelId="radar-panel" state={state} />
        <footer className={styles.footer}><p>От первого сигнала до нового вывода — в одной системе.</p><Cta /></footer>
      </div>
    </section>
  );
}

function EngineVariant() {
  const state = useTabs();
  const step = STEPS[state.active];
  return (
    <section className={`${styles.canvas} ${styles.enginePage}`} aria-labelledby="engine-title">
      <div className={styles.frame}>
        <Eyebrow number="02">Контентный процессор</Eyebrow>
        <header className={styles.heroHead}>
          <h1 id="engine-title">Из сигнала —<br /><span>в готовый пост.</span></h1>
          <p>Не набор генераторов, а технологическая линия: каждый модуль получает результат предыдущего и добавляет свою работу.</p>
        </header>

        <div className={styles.engineBoard}>
          <div className={styles.engineFlow} role="tablist" aria-label="Модули контентного процессора">
            <span className={styles.dataLine} aria-hidden="true"><i style={{ "--step": state.active } as CSSProperties} /></span>
            {STEPS.map((item, index) => (
              <StageButton
                key={item.id}
                index={index}
                active={state.active}
                prefix="engine-tab"
                panelId="engine-panel"
                register={state.register}
                onKeyDown={state.onKeyDown}
                onActivate={state.setActive}
              >
                <span>{item.num}</span><item.Icon aria-hidden="true" /><strong>{item.name}</strong><small>{item.metric}</small>
              </StageButton>
            ))}
          </div>
          <div className={styles.engineOutput}>
            <InfoPanel step={step} id="engine-panel" labelledBy={`engine-tab-${step.id}`} className={styles.infoPanel} />
            <div className={styles.postChip} aria-hidden="true">
              <span>Публикация / готова</span>
              <strong>Почему охваты растут<br />не от частоты постинга</strong>
              <i><Check />Факты проверены</i>
            </div>
          </div>
        </div>
        <footer className={styles.footer}><p>На входе — сигнал. На выходе — публикация и данные для следующего запуска.</p><Cta /></footer>
      </div>
    </section>
  );
}

function PostVariant() {
  const state = useTabs();
  const step = STEPS[state.active];
  const likes = [218, 218, 218, 259][state.active];
  const views = ["8,4K", "8,4K", "8,4K", "11,6K"][state.active];
  return (
    <section className={`${styles.canvas} ${styles.postPage}`} aria-labelledby="post-title">
      <div className={styles.frame}>
        <Eyebrow number="03">Живой SMM-пост</Eyebrow>
        <header className={styles.heroHead}>
          <h1 id="post-title">Пост под контролем.<br /><span>Рутина — нет.</span></h1>
          <p>Смотри, как один материал проходит путь от найденной темы до реакций реальной аудитории.</p>
        </header>

        <div className={styles.postStudio}>
          <div className={styles.postTabs} role="tablist" aria-label="Этапы работы над публикацией">
            {STEPS.map((item, index) => (
              <StageButton
                key={item.id}
                index={index}
                active={state.active}
                prefix="post-tab"
                panelId="post-panel"
                register={state.register}
                onKeyDown={state.onKeyDown}
                onActivate={state.setActive}
              >
                <span>{item.num}</span><item.Icon aria-hidden="true" /><strong>{item.name}</strong><small>{item.output}</small>
              </StageButton>
            ))}
          </div>

          <div className={styles.socialPost} role="group" aria-label="Пример публикации Авроры">
            <header><Logo size={36} decorative /><div><strong>Аврора</strong><span>@aurora_smm · 10:00</span></div><i>•••</i></header>
            <p>Почему охваты растут не от частоты постинга</p>
            <div className={styles.postMedia} aria-hidden="true">
              <span>Тренд недели</span><strong>Контент должен<br />помнить результат</strong><i>01 → 04</i>
            </div>
            <footer>
              <span><Heart />{likes}</span><span><MessageCircle />36</span><span><Send />18</span><span><Eye />{views}</span>
            </footer>
            <motion.div className={styles.postProgress} initial={false} animate={{ width: `${25 * (state.active + 1)}%` }} />
          </div>

          <InfoPanel step={step} id="post-panel" labelledBy={`post-tab-${step.id}`} className={styles.infoPanel} />
        </div>
        <footer className={styles.footer}><p>Ты подтверждаешь смысл. Аврора отвечает за движение материала.</p><Cta /></footer>
      </div>
    </section>
  );
}

const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

function WeekVariant() {
  const state = useTabs();
  const step = STEPS[state.active];
  return (
    <section className={`${styles.canvas} ${styles.weekPage}`} aria-labelledby="week-title">
      <div className={styles.frame}>
        <Eyebrow number="04">Умная SMM-неделя</Eyebrow>
        <header className={styles.heroHead}>
          <h1 id="week-title">Неделя собирается.<br /><span>Ты задаёшь направление.</span></h1>
          <p>Аврора находит темы, готовит материалы, ставит их в план и уточняет следующий слот по реакции аудитории.</p>
        </header>

        <div className={styles.weekBoard}>
          <div className={styles.weekTop}>
            <div><CalendarCheck2 /><span>12–18 августа</span></div>
            <strong>7 публикаций запланировано</strong>
          </div>
          <div className={styles.calendar} role="group" aria-label="Пример контент-плана на неделю">
            {DAYS.map((day, index) => (
              <div key={day} data-today={index === 2}>
                <span>{day}<small>{12 + index}</small></span>
                {index !== 5 ? <i data-kind={index % 3}><b>{index % 2 ? "Видео" : "Пост"}</b><strong>{index % 2 ? "Как удержать внимание" : "Разбор тренда"}</strong><small>{index % 3 === 2 ? "Опубликовано" : "10:00"}</small></i> : <em>Окно для реакции</em>}
              </div>
            ))}
          </div>
          <div className={styles.weekBottom}>
            <StageDock prefix="week-tab" panelId="week-panel" state={state} />
            <InfoPanel step={step} id="week-panel" labelledBy={`week-tab-${step.id}`} className={styles.infoPanel} />
          </div>
        </div>
        <footer className={styles.footer}><p>План не высечен в камне — он становится умнее после каждого выпуска.</p><Cta /></footer>
      </div>
    </section>
  );
}

function GrowthVariant({ embedded = false }: { embedded?: boolean }) {
  const state = useTabs();
  const step = STEPS[state.active];
  const Title = embedded ? "h2" : "h1";
  return (
    <section
      id={embedded ? "cycle" : undefined}
      className={`${styles.canvas} ${styles.growthPage}`}
      aria-labelledby="growth-title"
    >
      <div className={styles.frame}>
        <Eyebrow number="05">Контур роста</Eyebrow>
        <header className={styles.heroHead}>
          <Title id="growth-title">Каждая реакция<br /><span>делает контент точнее.</span></Title>
          <p>Аврора связывает публикацию с результатом: видно, что сработало, почему и как это повлияет на следующую тему.</p>
        </header>

        <div className={styles.growthBoard}>
          <div className={styles.metricHeader}>
            <div><span>Охват за 7 дней</span><strong>71 400</strong><small><TrendingUp /> +24%</small></div>
            <div><span>Вовлечение</span><strong>8,7%</strong><small><TrendingUp /> +1,4</small></div>
            <div><span>Сохранения</span><strong>1 284</strong><small><TrendingUp /> +18%</small></div>
          </div>
          <div className={styles.growthMain}>
            <div className={styles.chart} aria-hidden="true">
              <div className={styles.chartGrid} />
              <i className={styles.bar1} /><i className={styles.bar2} /><i className={styles.bar3} /><i className={styles.bar4} /><i className={styles.bar5} /><i className={styles.bar6} /><i className={styles.bar7} />
              <span className={styles.chartPulse}><Zap /></span>
              <p>Пост «Разбор тренда»<strong>11,6K охват</strong></p>
            </div>
            <InfoPanel
              step={step}
              id="growth-panel"
              labelledBy={`growth-tab-${step.id}`}
              className={styles.infoPanel}
              headingLevel={embedded ? "h3" : "h2"}
            />
          </div>
          <div className={styles.loopDock}>
            <StageDock prefix="growth-tab" panelId="growth-panel" state={state} />
            <span aria-hidden="true"><RefreshCw />Новый цикл</span>
          </div>
        </div>
        <footer className={styles.footer}><p>Не просто аналитика, а память, которая работает в следующей публикации.</p><Cta /></footer>
      </div>
    </section>
  );
}

export function GrowthCycleSection() {
  return (
    <div className={`${styles.lab} ${styles.embedded}`}>
      <div className={styles.backdrop} aria-hidden="true"><AirWave /></div>
      <GrowthVariant embedded />
    </div>
  );
}

export function CycleVariants({ variant }: { variant: CycleVariant }) {
  return (
    <div className={styles.lab}>
      <LabNav active={variant} />
      <div className={styles.backdrop} aria-hidden="true"><AirWave /></div>
      <main>
        {variant === 1 ? <RadarVariant /> : null}
        {variant === 2 ? <EngineVariant /> : null}
        {variant === 3 ? <PostVariant /> : null}
        {variant === 4 ? <WeekVariant /> : null}
        {variant === 5 ? <GrowthVariant /> : null}
      </main>
    </div>
  );
}
