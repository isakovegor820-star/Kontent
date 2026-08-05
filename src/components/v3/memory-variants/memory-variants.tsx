"use client";

import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowRight,
  Check,
  FileText,
  Gauge,
  Radio,
  ScanLine,
  ShieldCheck,
  Sparkles,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
import styles from "./memory-variants.module.css";

export type MemoryVariant = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export type ManifestAnimation = 0 | 1 | 2 | 3;

type MemorySource = {
  id: string;
  short: string;
  label: string;
  kind: string;
  amount: string;
  fact: string;
  detail: string;
  use: string;
  Icon: LucideIcon;
};

const SOURCES: MemorySource[] = [
  {
    id: "profile",
    short: "Анкета",
    label: "О тебе и продукте",
    kind: "Ответ владельца",
    amount: "12 фактов",
    fact: "Работаем с предпринимателями по всей России.",
    detail: "Специализация — налоговые проверки и споры. Исход дела заранее не обещаем.",
    use: "Даёт материалу конкретику: кому помогаем, с чем и на каких условиях.",
    Icon: UserRound,
  },
  {
    id: "materials",
    short: "Материалы",
    label: "Кейсы и документы",
    kind: "Добавленный текст",
    amount: "18 правил",
    fact: "До консультации проверяем требование, сроки и документы.",
    detail: "Память знает порядок работы и не пропускает детали, важные клиенту.",
    use: "Помогает объяснять процесс одинаково точно в каждом выпуске.",
    Icon: FileText,
  },
  {
    id: "channel",
    short: "Канал",
    label: "Архив публикаций",
    kind: "Открытые посты",
    amount: "46 примеров",
    fact: "Коротко. На «ты». Без юридического канцелярита.",
    detail: "Абзацы по 1–3 строки, спокойный тон, никаких запугиваний и громких обещаний.",
    use: "Учит подаче и ритму, но не подменяет фактическую опору.",
    Icon: Radio,
  },
];

const VARIANT_NAMES = [
  "Команды",
  "Сноски",
  "Факт / голос",
  "Индекс",
  "Квитанция",
  "Созвездие",
  "До / после",
  "Микшер",
  "Сканер",
  "Манифест",
] as const;

const EASE = [0.22, 1, 0.36, 1] as const;

function VariantNav({ active }: { active: MemoryVariant }) {
  return (
    <header className={styles.nav}>
      <Link href="/" className={styles.brand} aria-label="Вернуться на главную Авроры">
        <span>А</span>
        Аврора
      </Link>
      <div className={styles.currentVariant}>
        <small>Память канала · вариант {String(active).padStart(2, "0")}</small>
        <strong>{VARIANT_NAMES[active - 1]}</strong>
      </div>
      <nav aria-label="Десять вариантов дизайна памяти">
        {VARIANT_NAMES.map((name, index) => {
          const value = (index + 1) as MemoryVariant;
          return (
            <Link
              key={name}
              href={`/memory/${value}`}
              title={name}
              aria-label={`${value}. ${name}`}
              aria-current={active === value ? "page" : undefined}
            >
              {String(value).padStart(2, "0")}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}

function Cta({ inverse = false, label = "Собрать память канала" }: { inverse?: boolean; label?: string }) {
  return (
    <Link href="/register" className={`${styles.cta} ${inverse ? styles.ctaInverse : ""}`}>
      {label}
      <ArrowRight aria-hidden />
    </Link>
  );
}

function Swap({ id, children, className = "" }: { id: string; children: React.ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={id}
        className={className}
        initial={reduce ? false : { opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduce ? undefined : { opacity: 0, y: -12 }}
        transition={{ duration: 0.24, ease: EASE }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

function SourceTabs({ active, onChange, className = "" }: { active: number; onChange: (value: number) => void; className?: string }) {
  return (
    <div className={className} role="group" aria-label="Источники памяти">
      {SOURCES.map((source, index) => (
        <button
          key={source.id}
          type="button"
          aria-pressed={active === index}
          onMouseEnter={() => onChange(index)}
          onFocus={() => onChange(index)}
          onClick={() => onChange(index)}
        >
          <source.Icon aria-hidden />
          <span>{source.short}</span>
        </button>
      ))}
    </div>
  );
}

function CommandPalette() {
  const [active, setActive] = useState(0);
  const source = SOURCES[active];
  return (
    <section className={`${styles.scene} ${styles.command}`} aria-labelledby="v1-title">
      <div className={styles.sceneLabel}><span>01</span> Система памяти</div>
      <header className={styles.commandIntro}>
        <p>Память — это не папка с файлами.</p>
        <h1 id="v1-title">Спроси канал.<br />Получишь опору.</h1>
      </header>
      <div className={styles.commandGrid}>
        <div className={styles.commandMenu}>
          <span>⌘ Источники памяти</span>
          {SOURCES.map((item, index) => (
            <button key={item.id} type="button" aria-pressed={active === index} onClick={() => setActive(index)}>
              <kbd>0{index + 1}</kbd><item.Icon aria-hidden /><strong>{item.label}</strong><small>{item.amount}</small>
            </button>
          ))}
        </div>
        <Swap id={source.id} className={styles.commandAnswer}>
          <span className={styles.status}><i /> Найдено в памяти</span>
          <p>Можно ли написать конкретно?</p>
          <h2>{source.fact}</h2>
          <div><ShieldCheck aria-hidden /><p><small>Почему можно</small>{source.detail}</p></div>
          <footer><span>{source.kind}</span><strong>{source.use}</strong></footer>
        </Swap>
      </div>
      <div className={styles.commandBottom}><span>Никакой галлюцинации между вопросом и ответом.</span><Cta /></div>
    </section>
  );
}

function EditorialFootnotes() {
  const [active, setActive] = useState(0);
  const source = SOURCES[active];
  return (
    <section className={`${styles.scene} ${styles.footnotes}`} aria-labelledby="v2-title">
      <div className={styles.sceneLabel}><span>02</span> Редакционные сноски</div>
      <div className={styles.footnoteLayout}>
        <article className={styles.footnoteArticle}>
          <p className={styles.kicker}>Черновик Авроры · 09:40</p>
          <h1 id="v2-title">Текст звучит свободно.<br />Факты стоят твёрдо.</h1>
          <p className={styles.lead}>Каждое конкретное утверждение хранит ссылку на то, откуда оно взялось.</p>
          <p className={styles.articleCopy}>
            Мы помогаем <button type="button" onClick={() => setActive(0)}>предпринимателям по всей России<sup>1</sup></button> пройти налоговую проверку без паники. Сначала <button type="button" onClick={() => setActive(1)}>проверяем требование, сроки и документы<sup>2</sup></button>. Объясняем <button type="button" onClick={() => setActive(2)}>коротко и без канцелярита<sup>3</sup></button> — как привыкли читатели канала.
          </p>
        </article>
        <aside className={styles.marginNote}>
          <div className={styles.noteIndex}>0{active + 1}</div>
          <Swap id={source.id}>
            <span>{source.kind}</span>
            <h2>{source.fact}</h2>
            <p>{source.detail}</p>
            <footer><Check aria-hidden /> Подтверждено источником</footer>
          </Swap>
          <SourceTabs active={active} onChange={setActive} className={styles.noteTabs} />
        </aside>
      </div>
      <div className={styles.footnoteBottom}><p>Если у фразы нет сноски, Аврора убирает конкретику — а не придумывает её.</p><Cta /></div>
    </section>
  );
}

function SplitTruthVoice() {
  const [active, setActive] = useState<"fact" | "voice">("fact");
  return (
    <section className={`${styles.scene} ${styles.split}`} aria-labelledby="v3-title">
      <div className={styles.sceneLabel}><span>03</span> Факт / голос</div>
      <header className={styles.splitIntro}>
        <h1 id="v3-title">Одно отвечает<br />за правду.</h1>
        <h1>Другое —<br />за узнаваемость.</h1>
      </header>
      <div className={styles.splitStage}>
        <button type="button" className={styles.factSide} aria-pressed={active === "fact"} onClick={() => setActive("fact")}>
          <span>Факт · анкета</span><strong>Работаем с предпринимателями по всей России.</strong><small>Можно проверить</small>
        </button>
        <div className={styles.splitPlus}>+</div>
        <button type="button" className={styles.voiceSide} aria-pressed={active === "voice"} onClick={() => setActive("voice")}>
          <span>Голос · канал</span><strong>Спокойно. Коротко. Без канцелярита.</strong><small>Можно узнать</small>
        </button>
      </div>
      <div className={styles.splitResult}>
        <span>В материале</span>
        <p>«Разберём налоговую проверку без паники — по шагам и без обещаний невозможного».</p>
        <Cta inverse />
      </div>
    </section>
  );
}

function KineticIndex() {
  const [active, setActive] = useState(0);
  const source = SOURCES[active];
  return (
    <section className={`${styles.scene} ${styles.index}`} aria-labelledby="v4-title">
      <div className={styles.sceneLabel}><span>04</span> Живой индекс</div>
      <header className={styles.indexIntro}><p>Три места, где Аврора узнаёт канал.</p><h1 id="v4-title">Наведи —<br />и память заговорит.</h1></header>
      <div className={styles.indexBody}>
        <div className={styles.indexWords}>
          {SOURCES.map((item, index) => <button key={item.id} type="button" aria-pressed={active === index} onMouseEnter={() => setActive(index)} onFocus={() => setActive(index)} onClick={() => setActive(index)}>{item.short}</button>)}
        </div>
        <Swap id={source.id} className={styles.indexDetail}>
          <source.Icon aria-hidden /><span>{source.amount} · {source.kind}</span><h2>{source.fact}</h2><p>{source.use}</p>
        </Swap>
      </div>
      <footer className={styles.indexFooter}><span>Источник меняется. Принцип остаётся: ничего без опоры.</span><Cta /></footer>
    </section>
  );
}

function EvidenceReceipt() {
  const [active, setActive] = useState(0);
  const source = SOURCES[active];
  return (
    <section className={`${styles.scene} ${styles.receipt}`} aria-labelledby="v5-title">
      <div className={styles.sceneLabel}><span>05</span> Чек происхождения</div>
      <header className={styles.receiptIntro}><p>До публикации Аврора пробивает не цену.</p><h1 id="v5-title">Она пробивает<br />каждый факт.</h1></header>
      <div className={styles.receiptLayout}>
        <SourceTabs active={active} onChange={setActive} className={styles.receiptTabs} />
        <Swap id={source.id} className={styles.paperReceipt}>
          <header><strong>АВРОРА / ПАМЯТЬ</strong><span>№ 000{active + 1}</span></header>
          <div className={styles.receiptRule} />
          <dl><div><dt>ИСТОЧНИК</dt><dd>{source.kind}</dd></div><div><dt>ИЗВЛЕЧЕНО</dt><dd>{source.amount}</dd></div><div><dt>СТАТУС</dt><dd>ПОДТВЕРЖДЕНО</dd></div></dl>
          <blockquote>{source.fact}</blockquote>
          <p>{source.detail}</p>
          <div className={styles.receiptRule} />
          <footer><span>РАЗРЕШЕНО ДЛЯ МАТЕРИАЛА</span><strong>{source.use}</strong><i>НЕ ВЫДУМАНО</i></footer>
        </Swap>
        <div className={styles.receiptPromise}><ShieldCheck aria-hidden /><p><strong>У каждой конкретики есть происхождение.</strong> Его можно увидеть до выпуска.</p><Cta /></div>
      </div>
    </section>
  );
}

function MemoryConstellation() {
  const [active, setActive] = useState(0);
  const source = SOURCES[active];
  return (
    <section className={`${styles.scene} ${styles.constellation}`} aria-labelledby="v6-title">
      <div className={styles.sceneLabel}><span>06</span> Созвездие памяти</div>
      <header className={styles.constellationIntro}><p>Память не лежит мёртвым архивом.</p><h1 id="v6-title">Она собирается<br />в нужный момент.</h1></header>
      <div className={styles.orbit}>
        <div className={styles.orbitLines} aria-hidden><i /><i /><i /></div>
        {SOURCES.map((item, index) => <button key={item.id} data-node={index} type="button" aria-pressed={active === index} onClick={() => setActive(index)}><item.Icon aria-hidden /><span>{item.short}</span><small>{item.amount}</small></button>)}
        <div className={styles.orbitCore}><Sparkles aria-hidden /><span>Новый материал</span></div>
      </div>
      <Swap id={source.id} className={styles.constellationProof}><span>Активная опора · {source.label}</span><h2>{source.fact}</h2><p>{source.use}</p></Swap>
      <footer className={styles.constellationFooter}><p>Аврора подтягивает только нужные знания — без свалки контекста.</p><Cta inverse /></footer>
    </section>
  );
}

const AFTER = [
  { label: "Без памяти", text: "Мы — опытная компания. Оказываем качественные услуги и ценим каждого клиента." },
  { label: "+ факты", text: "Помогаем предпринимателям по всей России проходить налоговые проверки и споры." },
  { label: "+ процесс", text: "Сначала проверяем требование, сроки и документы — потом предлагаем следующий шаг." },
  { label: "+ голос", text: "Без паники и канцелярита: разберём требование, сроки и документы по шагам." },
] as const;

function BeforeAfter() {
  const [active, setActive] = useState(0);
  return (
    <section className={`${styles.scene} ${styles.beforeAfter}`} aria-labelledby="v7-title">
      <div className={styles.sceneLabel}><span>07</span> До / после памяти</div>
      <header className={styles.beforeIntro}><p>Не обещание. Разница в одном абзаце.</p><h1 id="v7-title">Узнай свой канал<br />в первой строке.</h1></header>
      <div className={styles.transformStage}>
        <div className={styles.transformSteps}>{AFTER.map((item, index) => <button key={item.label} type="button" aria-pressed={active === index} onClick={() => setActive(index)}><span>0{index}</span>{item.label}</button>)}</div>
        <Swap id={String(active)} className={styles.transformCopy}>
          <span>{AFTER[active].label}</span><blockquote>{AFTER[active].text}</blockquote><footer>{active === 0 ? <><X aria-hidden /> Можно написать о ком угодно</> : <><Check aria-hidden /> Всё точнее похоже на тебя</>}</footer>
        </Swap>
      </div>
      <div className={styles.beforeBottom}><p><strong>Память убирает универсальный ИИ-текст.</strong> Факты, процесс и подача приходят из твоих источников.</p><Cta /></div>
    </section>
  );
}

const MIXERS = [
  { label: "Факты", sub: "анкета", Icon: UserRound },
  { label: "Процесс", sub: "материалы", Icon: FileText },
  { label: "Голос", sub: "архив", Icon: Radio },
] as const;

function LayerMixer() {
  const [levels, setLevels] = useState([true, true, true]);
  const toggle = (index: number) => setLevels((current) => current.map((value, item) => item === index ? !value : value));
  const text = levels.every(Boolean)
    ? "Разберём налоговую проверку без паники: сначала требование, сроки и документы — потом следующий шаг."
    : levels[0] ? "Помогаем с налоговыми проверками по всей России."
      : levels[1] ? "Сначала изучаем документы, затем предлагаем следующий шаг."
        : levels[2] ? "Коротко. Спокойно. Без канцелярита."
          : "Добавь хотя бы одну опору — Аврора не станет писать из воздуха.";
  return (
    <section className={`${styles.scene} ${styles.mixer}`} aria-labelledby="v8-title">
      <div className={styles.sceneLabel}><span>08</span> Редакционный микшер</div>
      <header className={styles.mixerIntro}><p>Ты решаешь, что Аврора должна помнить.</p><h1 id="v8-title">Собери голос.<br />Не потеряй правду.</h1></header>
      <div className={styles.mixerConsole}>
        <div className={styles.channels}>{MIXERS.map((item, index) => <button key={item.label} type="button" aria-pressed={levels[index]} onClick={() => toggle(index)}><item.Icon aria-hidden /><span>{item.label}<small>{item.sub}</small></span><i><b style={{ height: levels[index] ? `${82 - index * 13}%` : "8%" }} /></i><strong>{levels[index] ? "ВКЛ" : "ВЫКЛ"}</strong></button>)}</div>
        <div className={styles.mixedOutput}><span><Gauge aria-hidden /> Материал на выходе</span><Swap id={levels.join("")}><blockquote>{text}</blockquote></Swap><footer><i className={levels.every(Boolean) ? styles.good : ""} />{levels.filter(Boolean).length} из 3 слоёв памяти активны</footer></div>
      </div>
      <div className={styles.mixerBottom}><span>Источники можно обновить в любой момент.</span><Cta inverse /></div>
    </section>
  );
}

const SCAN_PARTS = [
  { text: "Помогаем предпринимателям", source: "Анкета", proof: "Целевая аудитория подтверждена владельцем." },
  { text: "разобраться с налоговой проверкой", source: "Материалы", proof: "Специализация найдена в описании услуг и кейсах." },
  { text: "спокойно и без канцелярита.", source: "Архив", proof: "Ритм и тон извлечены из 46 опубликованных постов." },
] as const;

function ClaimScanner() {
  const [active, setActive] = useState(0);
  return (
    <section className={`${styles.scene} ${styles.scanner}`} aria-labelledby="v9-title">
      <div className={styles.sceneLabel}><span>09</span> Сканер утверждений</div>
      <header className={styles.scannerIntro}><p>Наведи на любую часть материала.</p><h1 id="v9-title">Прозрачность<br />до публикации.</h1></header>
      <div className={styles.scanStage}>
        <div className={styles.scanBeam}><ScanLine aria-hidden /><span>Сканирование завершено · 3 / 3</span></div>
        <blockquote>{SCAN_PARTS.map((part, index) => <button key={part.text} type="button" aria-pressed={active === index} onMouseEnter={() => setActive(index)} onFocus={() => setActive(index)} onClick={() => setActive(index)}>{part.text}<sup>0{index + 1}</sup></button>)}</blockquote>
        <Swap id={String(active)} className={styles.scanProof}><span>0{active + 1} · {SCAN_PARTS[active].source}</span><p>{SCAN_PARTS[active].proof}</p><strong><Check aria-hidden /> Опора найдена</strong></Swap>
      </div>
      <footer className={styles.scannerFooter}><p>Сомнительная фраза не дойдёт до очереди публикаций.</p><Cta /></footer>
    </section>
  );
}

const MANIFEST = [
  { word: "Знает.", note: "Кому ты помогаешь и в чём твоя реальная экспертиза.", meta: "12 фактов из анкеты" },
  { word: "Помнит.", note: "Как ты объясняешь сложное и какие формулировки не используешь.", meta: "46 примеров из канала" },
  { word: "Молчит.", note: "Когда подтверждения нет — конкретика не выдумывается.", meta: "0 фактов без источника" },
] as const;

const AURORA_LETTERS = ["А", "В", "Р", "О", "Р", "А"] as const;
const FLAP_LETTERS = ["Ж", "Б", "Л", "Ф", "П", "Я"] as const;

function AnimatedAurora({ mode }: { mode: ManifestAnimation }) {
  const reduce = useReducedMotion();
  const [hovered, setHovered] = useState(-1);
  const [run, setRun] = useState(0);
  const [gravity, setGravity] = useState(-1);
  const [pressed, setPressed] = useState(false);

  if (mode === 0 || reduce) return <>Аврора</>;

  if (mode === 1) {
    return (
      <button
        type="button"
        className={`${styles.auroraWord} ${styles.auroraElastic}`}
        aria-label="Запустить упругую анимацию слова Аврора"
        onClick={() => setRun((value) => value + 1)}
        onMouseLeave={() => setHovered(-1)}
      >
        {AURORA_LETTERS.map((letter, index) => {
          const isWave = run > 0;
          const distance = hovered < 0 ? 9 : Math.abs(hovered - index);
          return (
            <motion.span
              key={`${run}-${index}`}
              className={hovered === index ? styles.auroraLetterActive : undefined}
              onMouseEnter={() => setHovered(index)}
              animate={isWave
                ? { y: [0, -24, 10, -4, 0], scaleX: [1, 1.22, .88, 1.05, 1], scaleY: [1, .78, 1.18, .96, 1] }
                : { y: distance === 0 ? -10 : 0, scaleX: distance === 0 ? 1.22 : distance === 1 ? .9 : 1, scaleY: distance === 0 ? .86 : 1 }}
              transition={isWave ? { duration: .62, delay: index * .065, ease: EASE } : { duration: .18, ease: EASE }}
              onAnimationComplete={() => { if (isWave && index === AURORA_LETTERS.length - 1) setRun(0); }}
            >
              {letter}
            </motion.span>
          );
        })}
      </button>
    );
  }

  if (mode === 2) {
    return (
      <button
        type="button"
        className={`${styles.auroraWord} ${styles.auroraFlap}`}
        aria-label="Запустить анимацию механического табло Аврора"
        onClick={() => setRun((value) => value + 1)}
      >
        {AURORA_LETTERS.map((letter, index) => (
          <motion.span
            key={`${run}-${index}`}
            className={styles.flapCell}
            animate={run > 0 ? { rotateX: [0, -180, -360] } : { rotateX: 0 }}
            transition={{ duration: .72, delay: index * .085, ease: [0.76, 0, 0.24, 1] }}
            onAnimationComplete={() => { if (run > 0 && index === AURORA_LETTERS.length - 1) setRun(0); }}
          >
            <i>{letter}</i>
            <b>{FLAP_LETTERS[index]}</b>
          </motion.span>
        ))}
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`${styles.auroraWord} ${styles.auroraGravity}`}
      aria-label="Интерактивная гравитация слова Аврора"
      onPointerMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        const point = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
        setGravity(Math.round(point * (AURORA_LETTERS.length - 1)));
      }}
      onPointerLeave={() => { setGravity(-1); setPressed(false); }}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
    >
      {AURORA_LETTERS.map((letter, index) => {
        const distance = gravity < 0 ? 9 : Math.abs(gravity - index);
        const pull = Math.max(0, 4 - distance);
        const direction = gravity === index ? 0 : gravity > index ? 1 : -1;
        return (
          <motion.span
            key={index}
            className={gravity === index ? styles.auroraLetterActive : undefined}
            animate={{
              x: direction * pull * (pressed ? 14 : 7),
              y: pressed ? pull * 9 : -pull * 2,
              rotate: direction * pull * (pressed ? 4 : 1.5),
              scale: gravity === index ? (pressed ? 1.18 : 1.09) : 1,
            }}
            transition={{ type: "spring", stiffness: pressed ? 170 : 280, damping: pressed ? 14 : 22, mass: .75 }}
          >
            {letter}
          </motion.span>
        );
      })}
    </button>
  );
}

function MemoryManifesto({
  wordAnimation = 0,
  embedded = false,
}: {
  wordAnimation?: ManifestAnimation;
  embedded?: boolean;
}) {
  const [active, setActive] = useState(0);
  const titleId = embedded ? "memory-title" : "v10-title";
  return (
    <section
      id={embedded ? "memory" : undefined}
      className={`${styles.scene} ${styles.manifest} ${embedded ? styles.embeddedManifest : ""}`}
      aria-labelledby={titleId}
    >
      <div className={styles.sceneLabel}><span>10</span> Манифест памяти</div>
      {wordAnimation > 0 && !embedded ? (
        <nav className={styles.wordAnimationNav} aria-label="Варианты анимации слова Аврора">
          <span>Анимация слова</span>
          <Link href="/memory/10/word/1" aria-current={wordAnimation === 1 ? "page" : undefined}>01 Упругая</Link>
          <Link href="/memory/10/word/2" aria-current={wordAnimation === 2 ? "page" : undefined}>02 Табло</Link>
          <Link href="/memory/10/word/3" aria-current={wordAnimation === 3 ? "page" : undefined}>03 Гравитация</Link>
        </nav>
      ) : null}
      <header className={styles.manifestIntro}><p>Три свойства нормального редакционного ИИ.</p><h1 id={titleId}><AnimatedAurora mode={wordAnimation} /></h1></header>
      <div className={styles.manifestWords}>{MANIFEST.map((item, index) => <button key={item.word} type="button" aria-pressed={active === index} onMouseEnter={() => setActive(index)} onFocus={() => setActive(index)} onClick={() => setActive(index)}>{item.word}</button>)}</div>
      <Swap id={String(active)} className={styles.manifestProof}><span>{MANIFEST[active].meta}</span><p>{MANIFEST[active].note}</p></Swap>
      <footer className={styles.manifestFooter}><p>Так канал продолжает звучать как твой — даже когда ты не держишь редакцию в голове.</p><Cta inverse label="Дать Авроре опору" /></footer>
    </section>
  );
}

export function V3GravityMemoryManifest() {
  return <MemoryManifesto wordAnimation={3} embedded />;
}

export function MemoryVariants({ variant, manifestAnimation = 0 }: { variant: MemoryVariant; manifestAnimation?: ManifestAnimation }) {
  const content = [<CommandPalette key="1" />, <EditorialFootnotes key="2" />, <SplitTruthVoice key="3" />, <KineticIndex key="4" />, <EvidenceReceipt key="5" />, <MemoryConstellation key="6" />, <BeforeAfter key="7" />, <LayerMixer key="8" />, <ClaimScanner key="9" />, <MemoryManifesto key="10" wordAnimation={manifestAnimation} />];
  return <div className={styles.lab}><VariantNav active={variant} /><main id="main">{content[variant - 1]}</main></div>;
}
