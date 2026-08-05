"use client";

import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowRight, Check, Fingerprint, Minus, Plus, Radio, ShieldCheck, X } from "lucide-react";
import styles from "./memory-manifest-variants.module.css";

export type ManifestVariant = 1 | 2 | 3 | 4 | 5;

const NAMES = ["Три закона", "Разрез", "Можно / нельзя", "Эхо", "Формула"] as const;
const EASE = [0.22, 1, 0.36, 1] as const;

const LAWS = [
  {
    word: "Знает.",
    eyebrow: "Факты",
    meta: "12 подтверждённых фактов",
    text: "Кому ты помогаешь, в чём твоя экспертиза и какие обещания действительно можешь дать.",
  },
  {
    word: "Помнит.",
    eyebrow: "Голос",
    meta: "46 опубликованных примеров",
    text: "Как ты начинаешь пост, объясняешь сложное и какие слова никогда не используешь.",
  },
  {
    word: "Молчит.",
    eyebrow: "Границы",
    meta: "0 фактов без источника",
    text: "Если подтверждения нет, Аврора убирает конкретику — вместо того чтобы её придумать.",
  },
] as const;

const CUTS = [
  {
    line: "Канал",
    label: "Анкета",
    proof: "Аврора знает продукт, аудиторию и реальные условия работы.",
    sample: "Работаем с предпринимателями по всей России.",
  },
  {
    line: "не начинает",
    label: "Материалы",
    proof: "Кейсы и документы превращаются в факты и правила для новых выпусков.",
    sample: "Сначала проверяем требование, сроки и документы.",
  },
  {
    line: "с нуля.",
    label: "Архив",
    proof: "Прошлые публикации сохраняют ритм, лексику и редакционные привычки.",
    sample: "Коротко. На «ты». Без юридического канцелярита.",
  },
] as const;

const PERMISSIONS = [
  {
    mode: "Можно",
    title: "Быть конкретной.",
    text: "«Помогаем предпринимателям проходить налоговые проверки и споры».",
    proof: "Специализация подтверждена анкетой и материалами.",
  },
  {
    mode: "Нельзя",
    title: "Придумывать опору.",
    text: "«Гарантируем победу в любом споре».",
    proof: "Такого обещания нет ни в одном источнике — фраза блокируется.",
  },
] as const;

const ECHOES = [
  {
    source: "Анкета",
    count: "12 фактов",
    text: "Знает, о чём можно говорить предметно.",
    sample: "Налоговые проверки и споры для предпринимателей.",
  },
  {
    source: "Материалы",
    count: "18 правил",
    text: "Помнит детали, которые нельзя потерять в пересказе.",
    sample: "Сначала требование, сроки и документы — затем следующий шаг.",
  },
  {
    source: "Канал",
    count: "46 примеров",
    text: "Возвращает материал в узнаваемом ритме.",
    sample: "Спокойно, коротко и без канцелярита.",
  },
] as const;

function ManifestNav({ active }: { active: ManifestVariant }) {
  return (
    <header className={styles.nav}>
      <Link href="/memory/10" className={styles.brand} aria-label="Вернуться к манифесту памяти">
        <span>А</span>
        Аврора
      </Link>
      <div className={styles.current}>
        <small>Манифест · концепт {String(active).padStart(2, "0")}</small>
        <strong>{NAMES[active - 1]}</strong>
      </div>
      <nav aria-label="Пять концептов манифеста памяти">
        {NAMES.map((name, index) => {
          const value = (index + 1) as ManifestVariant;
          return (
            <Link
              key={name}
              href={`/memory/10/${value}`}
              aria-current={active === value ? "page" : undefined}
              aria-label={`${value}. ${name}`}
            >
              0{value}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}

function Cta({ light = false }: { light?: boolean }) {
  return (
    <Link href="/register" className={`${styles.cta} ${light ? styles.ctaLight : ""}`}>
      Дать Авроре опору
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
        initial={reduce ? false : { opacity: 0, y: 20, filter: "blur(5px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        exit={reduce ? undefined : { opacity: 0, y: -14, filter: "blur(4px)" }}
        transition={{ duration: 0.25, ease: EASE }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

function SceneLabel({ number, title }: { number: string; title: string }) {
  return <div className={styles.sceneLabel}><span>{number}</span>{title}</div>;
}

function ThreeLaws() {
  const [active, setActive] = useState(0);
  const law = LAWS[active];
  return (
    <section className={`${styles.scene} ${styles.laws}`} aria-labelledby="manifest-a-title">
      <SceneLabel number="01" title="Три закона памяти" />
      <header className={styles.lawsHeader}>
        <p>Не генератор текста.<br />Редактор с памятью.</p>
        <h1 id="manifest-a-title">Аврора</h1>
      </header>
      <div className={styles.lawWords}>
        {LAWS.map((item, index) => (
          <button
            key={item.word}
            type="button"
            aria-pressed={active === index}
            onMouseEnter={() => setActive(index)}
            onFocus={() => setActive(index)}
            onClick={() => setActive(index)}
          >
            <span>0{index + 1}</span>{item.word}
          </button>
        ))}
      </div>
      <Swap id={law.word} className={styles.lawProof}>
        <span>{law.eyebrow} · {law.meta}</span>
        <p>{law.text}</p>
      </Swap>
      <footer className={styles.lawFooter}>
        <p>Канал продолжает звучать как твой, даже когда редакцию держит Аврора.</p>
        <Cta light />
      </footer>
    </section>
  );
}

function TypographicCut() {
  const [active, setActive] = useState(0);
  const item = CUTS[active];
  return (
    <section className={`${styles.scene} ${styles.cut}`} aria-labelledby="manifest-b-title">
      <SceneLabel number="02" title="Типографический разрез" />
      <header className={styles.cutHeader}>
        <p>Три источника.<br />Один непрерывный голос.</p>
        <h1 id="manifest-b-title">Память<br />внутри текста.</h1>
      </header>
      <div className={styles.cutWords}>
        {CUTS.map((cut, index) => (
          <button
            key={cut.line}
            type="button"
            aria-pressed={active === index}
            onMouseEnter={() => setActive(index)}
            onFocus={() => setActive(index)}
            onClick={() => setActive(index)}
          >
            {cut.line}<sup>0{index + 1}</sup>
          </button>
        ))}
      </div>
      <Swap id={item.line} className={styles.cutProof}>
        <span>0{active + 1} · {item.label}</span>
        <div><p>{item.proof}</p><strong>«{item.sample}»</strong></div>
      </Swap>
      <footer className={styles.cutFooter}><span>Нажми на строку — увидишь её опору.</span><Cta /></footer>
    </section>
  );
}

function CanCannot() {
  const [active, setActive] = useState(0);
  const item = PERMISSIONS[active];
  return (
    <section className={`${styles.scene} ${styles.permission}`} aria-labelledby="manifest-c-title">
      <SceneLabel number="03" title="Можно / нельзя" />
      <header className={styles.permissionHeader}>
        <p>Память — это не только знания.<br />Это редакционные границы.</p>
        <h1 id="manifest-c-title">Честность<br />видна в тексте.</h1>
      </header>
      <div className={styles.permissionSwitch} role="group" aria-label="Разрешённые и запрещённые утверждения">
        {PERMISSIONS.map((option, index) => (
          <button key={option.mode} type="button" aria-pressed={active === index} onClick={() => setActive(index)}>
            {index === 0 ? <Check aria-hidden /> : <X aria-hidden />}
            {option.mode}
          </button>
        ))}
      </div>
      <Swap id={item.mode} className={styles.permissionStage}>
        <span>{item.mode}</span>
        <h2>{item.title}</h2>
        <blockquote>{item.text}</blockquote>
        <footer><ShieldCheck aria-hidden /><p>{item.proof}</p></footer>
      </Swap>
      <div className={styles.permissionBottom}><p>Конкретика появляется только там, где память может показать источник.</p><Cta light /></div>
    </section>
  );
}

function ChannelEcho() {
  const [active, setActive] = useState(0);
  const echo = ECHOES[active];
  return (
    <section className={`${styles.scene} ${styles.echo}`} aria-labelledby="manifest-d-title">
      <SceneLabel number="04" title="Эхо канала" />
      <header className={styles.echoHeader}>
        <p>Новое сообщение.<br />Знакомая подача.</p>
        <h1 id="manifest-d-title">Канал не<br />теряет себя.</h1>
      </header>
      <div className={styles.echoWords} aria-label="Источники памяти">
        {ECHOES.map((item, index) => (
          <button
            key={item.source}
            type="button"
            aria-pressed={active === index}
            onMouseEnter={() => setActive(index)}
            onFocus={() => setActive(index)}
            onClick={() => setActive(index)}
          >
            <span>{item.source}</span>Помнит
          </button>
        ))}
      </div>
      <Swap id={echo.source} className={styles.echoProof}>
        <Radio aria-hidden />
        <div><span>{echo.source} · {echo.count}</span><p>{echo.text}</p><strong>«{echo.sample}»</strong></div>
      </Swap>
      <footer className={styles.echoFooter}><p>Не копирует старые посты. Сохраняет то, почему они звучали твоими.</p><Cta /></footer>
    </section>
  );
}

function MemoryFormula() {
  const [parts, setParts] = useState([true, true, true]);
  const toggle = (index: number) => setParts((current) => current.map((value, item) => item === index ? !value : value));
  const count = parts.filter(Boolean).length;
  const result = count === 3
    ? "Точный материал в голосе канала."
    : count === 2
      ? "Уже похоже на тебя — но одна опора потеряна."
      : count === 1
        ? "Есть только фрагмент памяти. Текст будет слабее."
        : "Аврора не пишет из воздуха.";
  return (
    <section className={`${styles.scene} ${styles.formula}`} aria-labelledby="manifest-e-title">
      <SceneLabel number="05" title="Формула памяти" />
      <header className={styles.formulaHeader}>
        <p>Нажми на часть формулы.<br />Посмотри, что потеряется.</p>
        <h1 id="manifest-e-title">Не магия.<br />Опора.</h1>
      </header>
      <div className={styles.equation} role="group" aria-label="Слои памяти">
        <button type="button" aria-pressed={parts[0]} onClick={() => toggle(0)}><span>12</span>Факты</button>
        <Plus aria-hidden />
        <button type="button" aria-pressed={parts[1]} onClick={() => toggle(1)}><span>46</span>Голос</button>
        <Minus aria-hidden />
        <button type="button" aria-pressed={parts[2]} onClick={() => toggle(2)}><span>0</span>Выдумка</button>
      </div>
      <div className={styles.formulaResult}>
        <span>=</span>
        <Swap id={parts.join("")}>
          <small>{count} / 3 элемента формулы активны</small>
          <p>{result}</p>
        </Swap>
      </div>
      <footer className={styles.formulaFooter}><Fingerprint aria-hidden /><p><strong>Факт подтверждает содержание.</strong> Голос делает его твоим. Нулевая выдумка сохраняет доверие.</p><Cta /></footer>
    </section>
  );
}

export function MemoryManifestVariants({ variant }: { variant: ManifestVariant }) {
  const scenes = [<ThreeLaws key="1" />, <TypographicCut key="2" />, <CanCannot key="3" />, <ChannelEcho key="4" />, <MemoryFormula key="5" />];
  return <div className={styles.lab}><ManifestNav active={variant} /><main id="main">{scenes[variant - 1]}</main></div>;
}
