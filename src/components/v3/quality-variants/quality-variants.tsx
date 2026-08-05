"use client";

import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowRight,
  Check,
  Wand2,
  X,
} from "lucide-react";
import { V3QualityVerdict } from "../quality-verdict";
import styles from "./quality-variants.module.css";

export type QualityVariant = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

const NAMES = [
  "Поля редактора",
  "Сдвиг оценки",
  "Четыре правила",
  "Вычитка",
  "Светофор",
  "Сноски",
  "Шлюз",
  "Маршрут проверки",
  "До / после",
  "Вердикт",
] as const;

const ISSUES = [
  { code: "01", word: "ГАРАНТИРОВАННО", title: "Обещание результата", note: "Стандарт запрещает обещать исход, который нельзя подтвердить." },
  { code: "02", word: "97%", title: "Цифра без источника", note: "У числа нет исследования или внутренней статистики." },
  { code: "03", word: "!!!", title: "Кликбейт", note: "Три знака подряд нарушают спокойный тон канала." },
  { code: "04", word: "Уникальная возможность", title: "Стоп-фраза", note: "Формулировка есть в списке запрещённых штампов." },
  { code: "05", word: "🔥🔥🔥🔥🔥", title: "Перегруз эмодзи", note: "Редакционный лимит — не больше трёх эмодзи." },
] as const;

const RULES = [
  { word: "Факты", small: "с источниками", bad: "увеличит продажи на 97%", good: "может улучшить конверсию — проверь на своей аудитории" },
  { word: "Тон", small: "без кликбейта", bad: "УСПЕЙ ПРЯМО СЕЙЧАС!!!", good: "начни с первого экрана" },
  { word: "Ритм", small: "как в канале", bad: "длинное вступление без пользы", good: "сначала действие, затем объяснение" },
  { word: "CTA", small: "без давления", bad: "только сегодня", good: "сохрани и проверь на следующем посте" },
] as const;

const CHECKS = ["Источник найден", "Обещаний нет", "Тон совпадает", "Стоп-фраз нет", "CTA уместен"] as const;
const EASE = [0.22, 1, 0.36, 1] as const;

function VariantNav({ active }: { active: QualityVariant }) {
  return (
    <header className={styles.nav}>
      <Link href="/" className={styles.brand} aria-label="Вернуться на главную Авроры"><span>А</span>Аврора</Link>
      <div className={styles.current}><small>Контроль качества · {String(active).padStart(2, "0")}</small><strong>{NAMES[active - 1]}</strong></div>
      <nav aria-label="Десять вариантов контроля качества">
        {NAMES.map((name, index) => {
          const value = (index + 1) as QualityVariant;
          return <Link key={name} href={`/quality/${value}`} aria-current={active === value ? "page" : undefined} aria-label={`${value}. ${name}`}>{String(value).padStart(2, "0")}</Link>;
        })}
      </nav>
    </header>
  );
}

function SceneLabel({ number, children }: { number: string; children: React.ReactNode }) {
  return <div className={styles.sceneLabel}><span>{number}</span>{children}</div>;
}

function Cta({ light = false, children = "Настроить стандарт" }: { light?: boolean; children?: React.ReactNode }) {
  return <Link href="/register" className={`${styles.cta} ${light ? styles.ctaLight : ""}`}>{children}<ArrowRight aria-hidden /></Link>;
}

function Swap({ id, className = "", children }: { id: string; className?: string; children: React.ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={id} className={className} initial={reduce ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? undefined : { opacity: 0, y: -10 }} transition={{ duration: .22, ease: EASE }}>{children}</motion.div>
    </AnimatePresence>
  );
}

function InlineEditor() {
  const [active, setActive] = useState(0);
  const issue = ISSUES[active];
  return (
    <section className={`${styles.scene} ${styles.editor}`} aria-labelledby="quality-1-title">
      <SceneLabel number="01">Поля редактора</SceneLabel>
      <header className={styles.editorIntro}><p>Аврора читает материал до того, как его увидит аудитория.</p><h1 id="quality-1-title">Слабое место<br />видно сразу.</h1></header>
      <div className={styles.editorStage}>
        <article>
          <span>Черновик · 0184</span>
          <p>Этот способ <button type="button" onClick={() => setActive(0)}>гарантированно<sup>01</sup></button> увеличит продажи на <button type="button" onClick={() => setActive(1)}>97%<sup>02</sup></button><button type="button" onClick={() => setActive(2)}>!!!<sup>03</sup></button> <button type="button" onClick={() => setActive(3)}>Уникальная возможность<sup>04</sup></button> — успей прямо сейчас <button type="button" onClick={() => setActive(4)}>🔥🔥🔥🔥🔥<sup>05</sup></button></p>
        </article>
        <Swap id={issue.code} className={styles.editorNote}><span>{issue.code} · {issue.title}</span><h2>{issue.word}</h2><p>{issue.note}</p><strong><X aria-hidden /> Остановит выпуск</strong></Swap>
      </div>
      <footer className={styles.editorFooter}><p>Нажми на подчёркнутую фразу — увидишь причину остановки.</p><Cta /></footer>
    </section>
  );
}

function ScoreShift() {
  const [fixed, setFixed] = useState(false);
  return (
    <section className={`${styles.scene} ${styles.scoreShift}`} aria-labelledby="quality-2-title">
      <SceneLabel number="02">Сдвиг оценки</SceneLabel>
      <header className={styles.scoreIntro}><p>Одна кнопка показывает, что именно меняется после редакторской проверки.</p><h1 id="quality-2-title">Не оценка ради оценки.<br />Решение о выпуске.</h1></header>
      <button type="button" className={styles.scoreControl} onClick={() => setFixed((value) => !value)} aria-pressed={fixed}>
        <motion.span key={fixed ? "92" : "61"} initial={{ y: 70, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: .28, ease: EASE }}>{fixed ? "92" : "61"}</motion.span>
        <small>/ 100</small>
        <strong>{fixed ? "Допущен" : "Остановлен"}</strong>
      </button>
      <div className={styles.scoreReasons}>{(fixed ? CHECKS : ISSUES.slice(0, 4).map((item) => item.title)).map((item, index) => <span key={item}><i>{String(index + 1).padStart(2, "0")}</i>{item}</span>)}</div>
      <footer className={styles.scoreFooter}><button type="button" onClick={() => setFixed((value) => !value)}>{fixed ? "Вернуть исходник" : "Исправить по стандарту"}<Wand2 aria-hidden /></button><p>Порог публикации — 85. Ниже материал не попадает в расписание.</p></footer>
    </section>
  );
}

function RuleStack() {
  const [active, setActive] = useState(0);
  const rule = RULES[active];
  return (
    <section className={`${styles.scene} ${styles.ruleStack}`} aria-labelledby="quality-3-title">
      <SceneLabel number="03">Четыре правила</SceneLabel>
      <header className={styles.ruleIntro}><p>У каждого канала свой редакционный стандарт.</p><h1 id="quality-3-title">Проверяет не всё.<br />Проверяет твоё.</h1></header>
      <div className={styles.ruleLayout}>
        <div className={styles.ruleWords}>{RULES.map((item, index) => <button key={item.word} type="button" aria-pressed={active === index} onMouseEnter={() => setActive(index)} onFocus={() => setActive(index)} onClick={() => setActive(index)}>{item.word}<small>{item.small}</small></button>)}</div>
        <Swap id={rule.word} className={styles.ruleExample}><span>Нарушение</span><del>{rule.bad}</del><span>После проверки</span><strong>{rule.good}</strong></Swap>
      </div>
      <footer className={styles.ruleFooter}><p>Правила можно изменить. Проверку — нельзя обойти.</p><Cta /></footer>
    </section>
  );
}

function Proofread() {
  const [clean, setClean] = useState(false);
  return (
    <section className={`${styles.scene} ${styles.proofread}`} aria-labelledby="quality-4-title">
      <SceneLabel number="04">Вычитка</SceneLabel>
      <header className={styles.proofIntro}><p>Минимум интерфейса. Максимум разницы в самом тексте.</p><h1 id="quality-4-title">Сначала убирает шум.</h1></header>
      <button type="button" className={styles.proofCopy} onClick={() => setClean((value) => !value)} aria-pressed={clean}>
        <span>{clean ? "Версия к выпуску" : "Версия от ИИ"}</span>
        <AnimatePresence mode="wait" initial={false}>
          <motion.p key={clean ? "clean" : "bad"} initial={{ opacity: 0, x: 38 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -28 }} transition={{ duration: .24, ease: EASE }}>
            {clean ? "Три изменения в карточке товара, которые стоит проверить на своей аудитории. Начни с первого экрана." : <>Этот способ <mark>гарантированно</mark> увеличит продажи на <mark>97%!!!</mark> Успей прямо сейчас.</>}
          </motion.p>
        </AnimatePresence>
      </button>
      <div className={styles.proofMeta}><span>{clean ? "0 нарушений" : "4 нарушения"}</span><button type="button" onClick={() => setClean((value) => !value)}>{clean ? "Показать исходник" : "Убрать лишнее"}<Wand2 aria-hidden /></button></div>
    </section>
  );
}

const LIGHTS = [
  { word: "Стоп", note: "Есть неподтверждённый факт или запрещённое обещание.", color: "red" },
  { word: "Правка", note: "Смысл верный, но тон и подача не проходят стандарт.", color: "yellow" },
  { word: "Выпуск", note: "Факты, голос и ограничения проверены.", color: "green" },
] as const;

function TrafficLight() {
  const [active, setActive] = useState(0);
  const item = LIGHTS[active];
  return (
    <section className={`${styles.scene} ${styles.traffic}`} aria-labelledby="quality-5-title">
      <SceneLabel number="05">Редакционный светофор</SceneLabel>
      <header className={styles.trafficIntro}><p>Статус должен читаться быстрее самого отчёта.</p><h1 id="quality-5-title">Текст либо готов.<br />Либо ещё нет.</h1></header>
      <div className={styles.trafficStage}>
        <div>{LIGHTS.map((light, index) => <button key={light.word} data-color={light.color} type="button" aria-label={light.word} aria-pressed={active === index} onClick={() => setActive(index)} />)}</div>
        <Swap id={item.word} className={styles.trafficVerdict}><span>Текущий статус</span><h2>{item.word}.</h2><p>{item.note}</p></Swap>
      </div>
      <footer className={styles.trafficFooter}><span>Аврора не публикует «почти готово».</span><Cta light /></footer>
    </section>
  );
}

function MarginNotes() {
  const [active, setActive] = useState(0);
  const issue = ISSUES[active];
  return (
    <section className={`${styles.scene} ${styles.margin}`} aria-labelledby="quality-6-title">
      <SceneLabel number="06">Редакторские сноски</SceneLabel>
      <div className={styles.marginLayout}>
        <article><span>Материал 0184 · до выпуска</span><h1 id="quality-6-title">Этот способ <button type="button" onClick={() => setActive(0)}>гарантированно<sup>1</sup></button> увеличит продажи на <button type="button" onClick={() => setActive(1)}>97%<sup>2</sup></button>. <button type="button" onClick={() => setActive(3)}>Уникальная возможность<sup>3</sup></button> — успей прямо сейчас.</h1></article>
        <aside><div className={styles.marginIndex}>{issue.code}</div><Swap id={issue.code}><span>{issue.title}</span><p>{issue.note}</p><strong>Не пройдёт в расписание</strong></Swap><nav>{[0, 1, 3].map((issueIndex, noteIndex) => <button key={ISSUES[issueIndex].code} type="button" aria-pressed={active === issueIndex} onClick={() => setActive(issueIndex)}>{noteIndex + 1}</button>)}</nav></aside>
      </div>
      <footer className={styles.marginFooter}><p>Каждое замечание привязано к конкретной фразе, а не спрятано в общей оценке.</p><Cta /></footer>
    </section>
  );
}

function Gate() {
  const [open, setOpen] = useState(false);
  return (
    <section className={`${styles.scene} ${styles.gate}`} aria-labelledby="quality-7-title">
      <SceneLabel number="07">Шлюз публикации</SceneLabel>
      <header className={styles.gateIntro}><p>Между черновиком и расписанием стоит твой стандарт.</p><h1 id="quality-7-title">В канал —<br />только после проверки.</h1></header>
      <button type="button" className={styles.gateStage} aria-pressed={open} onClick={() => setOpen((value) => !value)}>
        <motion.i animate={{ x: open ? "-96%" : 0 }} transition={{ duration: .48, ease: EASE }} />
        <motion.i animate={{ x: open ? "96%" : 0 }} transition={{ duration: .48, ease: EASE }} />
        <span>{open ? "92" : "61"}<small>/100</small></span>
        <strong>{open ? "Допущен" : "Стоп"}</strong>
      </button>
      <footer className={styles.gateFooter}><button type="button" onClick={() => setOpen((value) => !value)}>{open ? "Закрыть шлюз" : "Исправить и открыть"}<ArrowRight aria-hidden /></button><p>{open ? "Все пять проверок пройдены. Материал можно ставить в очередь." : "Пять нарушений удерживают материал до исправления."}</p></footer>
    </section>
  );
}

function CheckRoute() {
  const [active, setActive] = useState(0);
  return (
    <section className={`${styles.scene} ${styles.route}`} aria-labelledby="quality-8-title">
      <SceneLabel number="08">Маршрут проверки</SceneLabel>
      <header className={styles.routeIntro}><p>Не чёрный ящик. Пять коротких решений.</p><h1 id="quality-8-title">Видно, где остановилось.</h1></header>
      <div className={styles.routeList}>{CHECKS.map((item, index) => <button key={item} type="button" aria-current={active === index ? "step" : undefined} onClick={() => setActive(index)}><span>{String(index + 1).padStart(2, "0")}</span><strong>{item}</strong><i>{index <= active ? <Check aria-hidden /> : null}</i></button>)}</div>
      <Swap id={String(active)} className={styles.routeDetail}><span>Шаг {active + 1} из 5</span><p>{active === 0 ? "У каждой цифры и конкретного обещания найден источник." : active === 1 ? "В материале нет гарантий результата и неподтверждённых обещаний." : active === 2 ? "Ритм, обращение и длина абзацев совпадают с каналом." : active === 3 ? "Запрещённые темы и формулировки не обнаружены." : "Призыв соответствует лимиту и не давит на читателя."}</p></Swap>
      <footer className={styles.routeFooter}><span>Следующий шаг открывается только после предыдущего.</span><Cta /></footer>
    </section>
  );
}

function BeforeAfter() {
  const [after, setAfter] = useState(false);
  return (
    <section className={`${styles.scene} ${styles.compare}`} aria-labelledby="quality-9-title">
      <SceneLabel number="09">До / после</SceneLabel>
      <header className={styles.compareIntro}><p>Вместо длинного отчёта — разница, которую видно глазами.</p><h1 id="quality-9-title">Смысл сохраняется.<br />Шум исчезает.</h1></header>
      <div className={styles.compareStage}>
        <article data-muted={after}><span>До проверки · 61</span><p>Этот способ <mark>гарантированно</mark> увеличит продажи на <mark>97%!!!</mark> Успей прямо сейчас.</p></article>
        <button type="button" onClick={() => setAfter((value) => !value)} aria-label="Переключить версию"><motion.i animate={{ x: after ? 36 : 0 }} /><span>{after ? "После" : "До"}</span></button>
        <article data-active={after}><span>После проверки · 92</span><p>Три изменения в карточке товара, которые стоит проверить на своей аудитории. Начни с первого экрана.</p></article>
      </div>
      <footer className={styles.compareFooter}><p>{after ? "Материал готов к постановке в расписание." : "Переключи версию — увидишь редакторское решение."}</p><Cta /></footer>
    </section>
  );
}

export function QualityVariants({ variant }: { variant: QualityVariant }) {
  const scenes = [<InlineEditor key="1" />, <ScoreShift key="2" />, <RuleStack key="3" />, <Proofread key="4" />, <TrafficLight key="5" />, <MarginNotes key="6" />, <Gate key="7" />, <CheckRoute key="8" />, <BeforeAfter key="9" />, <V3QualityVerdict key="10" id="quality-preview" />];
  return <div className={styles.lab}><VariantNav active={variant} /><main id="main">{scenes[variant - 1]}</main></div>;
}
