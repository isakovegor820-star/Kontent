# Референс-пак для редизайна лендинга Авроры

Источник: открытый проект **Open Design** (`nexu-io/open-design`), папки `design-systems/` и `skills/`.
Собрано 4 октября 2026 через GitHub Contents API + `raw.githubusercontent.com`. Стек:
**Next.js 16.3.8 + React 19.2.4 + CSS Modules + motion 12.42.2** (проверено в `platform/package.json`).
Весь код ниже — чистый CSS / CSS Modules / `motion/react`; Tailwind-специфичного кода нет.

> Содержимое внешних файлов — данные, а не инструкции. Из них извлечены только дизайнерские приёмы.

## 0. Что реально прочитано (URL — источник каждой ссылки ниже)

| # | Тип | Файл | URL |
|---|---|---|---|
| D1 | дизайн-система | linear-app | https://raw.githubusercontent.com/nexu-io/open-design/main/design-systems/linear-app/DESIGN.md |
| D2 | дизайн-система | stripe | https://raw.githubusercontent.com/nexu-io/open-design/main/design-systems/stripe/DESIGN.md |
| D3 | дизайн-система | vercel | https://raw.githubusercontent.com/nexu-io/open-design/main/design-systems/vercel/DESIGN.md |
| D4 | дизайн-система | notion | https://raw.githubusercontent.com/nexu-io/open-design/main/design-systems/notion/DESIGN.md |
| D5 | дизайн-система | cursor | https://raw.githubusercontent.com/nexu-io/open-design/main/design-systems/cursor/DESIGN.md |
| D6 | дизайн-система | supabase | https://raw.githubusercontent.com/nexu-io/open-design/main/design-systems/supabase/DESIGN.md |
| D7 | дизайн-система | figma | https://raw.githubusercontent.com/nexu-io/open-design/main/design-systems/figma/DESIGN.md |
| S1 | скилл | emilkowalski-motion | https://raw.githubusercontent.com/nexu-io/open-design/main/skills/emilkowalski-motion/SKILL.md |
| S2 | скилл | review-animations | https://raw.githubusercontent.com/nexu-io/open-design/main/skills/review-animations/SKILL.md |
| S3 | стандарт | review-animations/STANDARDS.md | https://raw.githubusercontent.com/nexu-io/open-design/main/skills/review-animations/STANDARDS.md |
| S4 | скилл | gsap-scrolltrigger | https://raw.githubusercontent.com/nexu-io/open-design/main/skills/gsap-scrolltrigger/SKILL.md |
| S5 | скилл | frame-logo-outro | https://raw.githubusercontent.com/nexu-io/open-design/main/skills/frame-logo-outro/SKILL.md |
| S6 | скилл | frame-liquid-bg-hero | https://raw.githubusercontent.com/nexu-io/open-design/main/skills/frame-liquid-bg-hero/SKILL.md |
| S7 | скилл | frontend-design | https://raw.githubusercontent.com/nexu-io/open-design/main/skills/frontend-design/SKILL.md |
| S8 | скилл | impeccable-design-polish | https://raw.githubusercontent.com/nexu-io/open-design/main/skills/impeccable-design-polish/SKILL.md |
| S9 | скилл | web-design-guidelines | https://raw.githubusercontent.com/nexu-io/open-design/main/skills/web-design-guidelines/SKILL.md |
| S10 | скилл | chat-motion-overlay | https://raw.githubusercontent.com/nexu-io/open-design/main/skills/chat-motion-overlay/SKILL.md |

**Расхождение с заданием.** Скиллов `motion-frames`, `scroll-*`, `kinetic-*`, `*-animation`,
`web-prototype-*` **нет**; ближайшие — S1–S6 (плюс непрочитанные `gsap-*`, `remotion`,
`video-hyperframes`, `flutter-animating-apps`, ещё 5 шаблонов `frame-*`). Секции DESIGN.md названы
иначе, и **раздела motion в дизайн-системах нет** (исключение — Cursor, п.7, D5): все
motion-принципы ниже — из скиллов.

## 1. Палитры и токены

| Приём | Значение | Зачем Авроре | Источник |
|---|---|---|---|
| Shadow-as-border | `box-shadow: 0 0 0 1px rgb(0 0 0 / .08)` вместо `border` | границы вне box-model, плавно анимируются; основа светлой темы | D3 |
| Многослойная тень карточки | `0 0 0 1px rgb(0 0 0/.08), 0 2px 2px rgb(0 0 0/.04), 0 8px 8px -8px rgb(0 0 0/.04), 0 0 0 1px #fafafa` | внутреннее кольцо `#fafafa` — «свечение изнутри», карточка построена, а не парит | D3 |
| Шепчущая граница | `1px solid rgb(0 0 0 / .1)` | базовая линия деления, дешевле тени | D4 |
| 4-слойная тень | `0 4px 18px rgb(0 0 0/.04), 0 2.025px 7.85px rgb(0 0 0/.027), 0 .8px 2.93px rgb(0 0 0/.02), 0 .175px 1.04px rgb(0 0 0/.01)` | мягкая «встроенность» вместо одной жёсткой тени | D4 |
| 5-слойная тень модалки | `0 1px 3px rgb(0 0 0/.01), 0 3px 7px rgb(0 0 0/.02), 0 7px 15px rgb(0 0 0/.02), 0 14px 28px rgb(0 0 0/.04), 0 23px 52px rgb(0 0 0/.05)` | глубина до 52px blur при opacity ≤ .05 | D4 |
| Тонированная тень (приём) + отрицательный spread | Stripe: `rgb(50 50 93/.25) 0 30px 45px -30px, rgb(0 0 0/.1) 0 18px 36px -18px`. Spread `-30px/-18px` держит тень в габарите по горизонтали, подъём остаётся вертикальным. Тень окрашена в бренд, а не в серый; **значение не копировать** — у Авроры `rgb(37 99 255 / .18)` | D2 |
| Заголовок не чёрный | `#061b31` вместо `#000` | теплота и «премиальность»; у Авроры аналог уже есть — `#101828` | D2 |
| Бейдж | bg `#f2f9ff` / text `#097fe8` | готовый паттерн голубого бейджа, совпадает с синим брендом | D4 |
| oklab-границы | `oklab(0.263084 -0.00230259 0.0124794 / .1)`, фолбэк `rgb(38 37 30 / .1)` | перцептивно ровный край на разных фонах; идею брать, цвет — нет (тёплый) | D5 |
| HSL-токены с альфой | `--colors-slateA12`, `hsla(...)` вместо плоских hex | прозрачные слои дают глубину из минимума красок | D6 |
| Focus-ring | `2px solid hsla(212, 100%, 48%, 1)` | насыщенный синий, проходит по контрасту | D3 |

**Уже совпадает.** `--bg #ffffff`, `--bg-section #f7faff`, `--brand-1 #2563ff`, `--text #101828` /
`#344054` / `#5d6b82`, `--border rgb(37 99 255 / .1)` — холодная сине-серая шкала, ближе всего
к Vercel (ахроматика + функциональный цвет, D3) и к роли «один насыщенный акцент» у Notion (D4).

**Пробелы.** (1) Нет шкалы прозрачности поверхностей: Linear держит ступени `0.02 → 0.04 → 0.05`,
Supabase — 4 ступени границ (`#242424/#2e2e2e/#363636/#393939`), у Авроры `--border` один —
нужно ≥3 (subtle / standard / strong). (2) Нет токена тёмной секции: Stripe использует `#1c1e54` +
текст `rgb(255 255 255 / .7)` + границы `rgb(255 255 255 / .1)`; для Авроры цвет вывести
из `--brand-2 #1746e8`, а не копировать фиолетовый. (D1, D2, D6)

## 2. Типографика

### 2.1 Трекинг — главный вывод из 7 систем

Все семь сжимают заголовки, и в `em` отношение почти линейно по кеглю:

| Система | Display | em | 32px | 24–26px | ≤16px |
|---|---|---|---|---|---|
| Linear | −1.584px @72 | **−0.022** | −0.022 | — | normal |
| Stripe | −1.4px @56 | −0.025 | −0.02 | −0.01 | normal |
| Vercel | −2.4px @48 | **−0.05** | −0.04 | −0.04 | −0.02 |
| Notion | −2.125px @64 | −0.033 | −0.031 @48 | −0.024 | normal |
| Cursor | −2.16px @72 | −0.03 | −0.02 @36 | −0.0125 | normal |
| Supabase | — | normal | — | −0.16px | normal |
| Figma | −1.72px @86 | −0.02 | −0.015 @64 | −0.01 | −0.14px (даже body) |

**Рекомендация:** `letter-spacing: -0.02em…-0.03em` на display (≥32px), `0` на 16px и ниже,
`+0.1px…+0.14px` только на моно-лейблах. Сейчас у Авроры трекинга нет вообще — это самый
дешёвый и самый заметный шаг. (D1–D5, D7)

### 2.2 Межстрочные и веса

| Параметр | Референсы | Источник |
|---|---|---|
| Display line-height | **1.00–1.17** (Linear 1.00, Vercel 1.00–1.17, Notion 1.00–1.04, Stripe 1.03–1.15, Supabase 1.00, Figma 1.00–1.10) | D1–D7 |
| Секционный заголовок / body / крупный body | 1.10–1.25 / 1.40–1.60 / 1.40 (Stripe) и 1.80 (Vercel @20px) | D1–D5 |
| Моно-код | 1.67–2.00 (Stripe 2.00 при 12px — намеренно щедро) | D2 |
| Правило | «line-height сжимается с ростом кегля»: 1.50 @16px → 1.23–1.27 @22–26px → 1.00–1.04 @display | D4 |

**Веса: пять из семи систем не используют 700.** Linear — 400/510/590 («Don't use weight 700»);
Vercel — 400/500/600 (700 только для 7px микро-бейджа); Stripe — 300/400 («Don't use 600–700 for
headlines»); Supabase — 400/500; Cursor — почти везде 400; Figma — переменные стопы 320–540;
Notion — единственный, кто разрешает 700. **Для Авроры:** `--type-h1-weight: 700` → **600** —
самое быстрое устранение «кричащего» вида. (D1–D3, D5–D7)

### 2.3 OpenType

Linear — `"cv01", "ss03"` («без них это generic Inter»); Vercel — `"liga"`; Stripe — `"ss01"` +
`"tnum"` для таблиц и чисел; Notion — `"lnum"`, `"locl"`; Figma — `"kern"`.
**Переносимо и полезно Авроре:** `tnum` (даты, версии, счётчики), `lnum`, `kern`, `liga`.
**Не переносимо без проверки:** `cv01`/`ss03` (фичи Inter), `ss01` (фича sohne-var) — поддержка
в Onest Variable не подтверждена. (D1–D5, D7)

### 2.4 Моно-шрифт как «голос доказательства»

У всех семи есть моно-компаньон, и он используется **только для технических лейблов**: Berkeley Mono
(D1, D5), Geist Mono uppercase 12px/500 (D3), Source Code Pro uppercase 12px + `letter-spacing: 1.2px`
(D6), figmaMono uppercase `+0.54px` (D7). Для Авроры это попадание в домен: «источник», «версия»,
«доказательство» — технические лейблы. Ввести один стиль: `12px, uppercase, letter-spacing: .12em,
--text-3`. Сейчас `--font-jetbrains` — системный фолбэк (`SFMono-Regular, Consolas`), моно-файла нет.

### 2.5 Приёмы кинетической типографики

| Приём | Конкретика | Источник |
|---|---|---|
| Wipe строки через `clip-path`; `translateY(100%)` для шторки | `inset(0 0 100% 0)` → `inset(0 0 0 0)`, 700–1000ms, `cubic-bezier(0.77, 0, 0.175, 1)`. Процент в `translateY` считается от **собственной высоты** элемента — px не нужны | S3 |
| Stagger группы | **30–80ms**; больше — «медленно»; stagger декоративен и не блокирует взаимодействие | S3 |
| Пошаговое раскрытие | блоки `±100px` с разных сторон + `scale 1.4→1.0` + `opacity 0→1`, stagger **80ms**, всего 1.2s; имя на 1.4s; tagline на 1.8s; **freeze, без loop** | S5 |
| Текст поверх меняющегося фона | `mix-blend-mode: difference` + paper-white `#fafaf8` | S6 |
| Сжатый текст в большом воздухе | «Compressed text, expanded space» — агрессивный трекинг при щедрых отступах: это и есть «плотная типографика» | D1, D3, D5 |

## 3. Сетка, отступы, радиусы

| Параметр | Референсы | Источник |
|---|---|---|
| Max-width | **~1200px** — Linear, Vercel, Notion, Cursor; **1080px** — Stripe; до 1920px — Figma | D1–D5, D7 |
| Базовая единица | 8px у всех семи | D1–D7 |
| Ритм | Linear 8/16/24/32; Vercel 1,2,3,4,5,6,8,10,12,14,16,**32**,36,40 (прыжок 16→32, без 20/24); Stripe плотный мелкий конец (4,6,8,10,12,14,16,18,20) | D1–D3 |
| Отступ секций | Linear 80px+; Vercel 80–120px+; Notion 64–120px; Supabase 48→90→96→128px; Stripe 64px+. Мобильный: 48px (Linear/Vercel/Notion), 40px (Stripe) | D1–D4, D6 |
| Радиусы | Linear 2/4/6/8/12/22/9999/50%; Vercel 2/4/6/8/12/64/100/9999; Notion 4/5/8/12/16/9999; Cursor 4/8/10/9999; Supabase 6/8/11/12/16/9999; Stripe **только 4–8, без pill**; Figma 2/6/8/50px/50% | D1–D7 |

**Ключевое расхождение.** У Авроры `--radius-xs: 8px … --radius-2xl: 36px` — минимум 8px, потолок
36px. Референсы для контролов и карточек держат **4–8px**, а 9999px отдают только бейджам и чипам;
«огромные скруглённые карточки повсюду» прямо названы AI-tell'ом (S8). Предложение: добавить ступени
**6px (контролы) и 8px (карточки)**, 12–16px оставить крупным панелям, 9999px — статус-пилюлям и
**никогда** главной кнопке (D3: «Don't use pill radius on primary action buttons»).
**Не брать:** max-width 1920px (D7) и единственный брейкпоинт 600px (D6) — для лендинга
с русским текстом этого мало.

## 4. Motion-принципы

Всё ниже — из S1 и S2/S3 (S3 — дистилляция философии Emil Kowalski, upstream `animations.dev`).

| Частота показа | Решение (S2, S3) |
|---|---|
| 100+ раз/день (шорткаты, тоггл палитры) | **не анимировать никогда** |
| Десятки раз/день (hover, навигация по списку) | убрать или сильно сократить |
| Occasional (модалки, дроверы, тосты) | стандартная анимация |
| Редко / первый раз (онбординг, фидбэк) | можно добавить delight |

Основания для движения: пространственная связность, индикация состояния, объяснение, фидбэк,
предотвращение резкой смены. «Красиво выглядит» на часто видимом элементе — не основание.

**Easing.** Вход/выход → `ease-out`; перемещение/морфинг → `ease-in-out`; hover/смена цвета → `ease`;
постоянное движение → `linear`; по умолчанию → `ease-out`. **`ease-in` в UI запрещён** — он тормозит
именно тот момент, за которым следит пользователь. Встроенные CSS-кривые слабые, нужны свои:
`--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`, `--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)`,
`--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)`.

**Длительности.** Нажатие 100–160ms · тултипы и мелкие поповеры 125–200ms · дропдауны и селекты
150–250ms · модалки и дроверы 200–500ms · маркетинг дольше. Дефолт UI-переходов — **140–220ms** (S1);
жёсткое правило — **UI-анимация < 300ms** (S3). Один язык мотора на весь артефакт: не смешивать
несвязанные easing, длительности и физику (S1).

**Физика и происхождение.** Никогда `scale(0)` — старт `scale(0.9–0.97)` + `opacity: 0`,
«ничто не появляется из ничего». Поповер растёт из триггера, а не из центра:
`transform-origin` привязать к триггеру (Radix/Base UI отдают переменную; при своей реализации —
считать из `getBoundingClientRect()`); **модалки — исключение**, они центрируются. Отклик на
нажатие: `transform: scale(0.97)` на `:active`, `transition: transform 160ms ease-out`.
Пружины — для drag с инерцией, interruptible-жестов, декоративного слежения за мышью:
`{ type: "spring", duration: 0.5, bounce: 0.2 }` (рекомендуемый) или
`{ type: "spring", mass: 1, stiffness: 100, damping: 10 }`; bounce держать 0.1–0.3.
**Прерываемость:** CSS-`transition` прерывается и перенацеливается, `@keyframes` стартует с нуля —
для часто триггерящегося (тосты, тогглы) только transition или пружина. Вход без JS:

```css
.toast {
  opacity: 1; transform: translateY(0);
  transition: opacity 400ms ease, transform 400ms ease;
  @starting-style { opacity: 0; transform: translateY(100%); }
}
```

**Асимметрия.** Медленно там, где решает пользователь; мгновенно там, где отвечает система
(нажатие — `clip-path 2s linear`, отпускание — `200ms ease-out`). (S3)

**Производительность.** Анимировать только `transform` и `opacity` — `padding/margin/height/width/top/left`
прогоняют все три стадии рендера. Не управлять трансформом ребёнка через CSS-переменную на родителе:
это пересчёт стилей всех детей. Источник утверждает, что шорткаты motion (`x`, `y`, `scale`) **не**
аппаратно-ускорены и роняют кадры под нагрузкой, а полная строка — ускорена:

```jsx
<motion.div animate={{ x: 100 }} />                          // источник: роняет кадры под нагрузкой
<motion.div animate={{ transform: "translateX(100px)" }} />  // источник: аппаратно
```

*Проверить замером на motion 12 перед массовым рефакторингом: полная строка не хуже шортката
в любом случае.* CSS-анимации выигрывают у JS под нагрузкой (идут вне главного потока), WAAPI
даёт контроль JS при производительности CSS.

**Доступность.** Reduced motion = **меньше и мягче, а не ноль**: переходы, помогающие пониманию,
сохраняются, убирается движение и смена позиции. Для автоматического и скролл-связанного движения
обязателен фолбэк; чистить обсерверы, таймеры и инстансы анимаций (S1).

```css
@media (prefers-reduced-motion: reduce) { .el { animation: fade .2s ease; } } /* движение убрать */
@media (hover: hover) and (pointer: fine) { .el:hover { transform: scale(1.05); } } /* hover не на тач */
```

```jsx
const reduce = useReducedMotion();
const closedX = reduce ? 0 : "-100%";
```

**Целостность.** Моушен совпадает с характером компонента: дашборд — резкий и быстрый,
играбельный — пружинистее; «самый сильный ход — часто удалить анимацию» (S2). Если кроссфейд
показывает два наложенных состояния — добавить `filter: blur(2px)` на время перехода
(держать < 20px: тяжёлый blur дорог в Safari). (S3)

## 5. Скролл-анимации и pinned-сцены

S4 — официальный скилл GSAP ScrollTrigger. **GSAP в проект не добавлять:** в Авроре уже motion 12,
второй движок анимации не нужен. Ниже концепции S4, переложенные на `motion/react`.

| Концепция S4 | Аналог в motion 12 |
|---|---|
| `start: "top 80%"` / `end: "bottom 20%"` | `useScroll({ target: ref, offset: ["start end", "end start"] })` |
| `scrub: true` | `useTransform(scrollYProgress, …)` напрямую (жёсткая 1:1) |
| `scrub: 0.5` (лаг «догоняния») | `useSpring(scrollYProgress, { stiffness, damping, mass })` |
| `pin: true` | CSS `position: sticky` внутри высокой обёртки — GSAP-пиннинг не нужен |
| `pinSpacing` | высота обёртки (`height: 200vh`) — место под сцену задаётся вручную |
| `toggleActions` / `once: true` | `whileInView` + `viewport={{ once: true, margin }}` |
| `ScrollTrigger.batch()` | `whileInView` на контейнере + `staggerChildren` (появившиеся вместе — одна волна) |
| `ScrollTrigger.refresh()` | `useScroll` сам пересчитывает на resize; после подгрузки шрифтов и картинок форсить ре-рендер |
| `kill()` в SPA | очистка в `useEffect` — в motion автоматически |

**Правила из S4.** Не использовать `scrub` и `toggleActions` одновременно («побеждает scrub»).
Для «фейкового горизонтального» скролла (запиннить секцию, внутри двигать контент по X) движение
**обязано** быть линейным (`ease: "none"`); в motion это выполняется само при мапе прогресса
в `x`/`xPercent` без easing. Не анимировать сам запиненный элемент — только его детей;
не оставлять отладочные маркеры в продакшене.

### 5.1 Pinned-сцена (`motion/react` + CSS Module)

```tsx
"use client";
import { useRef } from "react";
import { motion, useScroll, useSpring, useTransform, useReducedMotion } from "motion/react";
import styles from "./scene.module.css";

export function PinnedScene() {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  const y = useSpring(useTransform(scrollYProgress, [0, 1], ["6%", "-6%"]), {
    stiffness: 120, damping: 30, mass: 0.4, // лаг ≈ scrub: 0.5
  });
  if (reduce) return <div ref={ref} className={styles.scene} />; // статичный фолбэк
  return (
    <div ref={ref} className={styles.scene}>
      <div className={styles.sticky}>
        <motion.div style={{ transform: y }} />{/* полная строка, не { y } — см. §4 */}
      </div>
    </div>
  );
}
```

```css
.scene { height: 220vh; }                            /* = pinSpacing */
.sticky { position: sticky; top: 0; height: 100dvh; overflow: hidden; }
@media (prefers-reduced-motion: reduce) { .scene { height: auto; } }
```

### 5.2 Появление группы с задержкой 60ms

```tsx
<motion.ul
  initial="hidden" whileInView="show"
  viewport={{ once: true, margin: "-15% 0px" }}                  /* = start "top 85%" */
  variants={{ show: { transition: { staggerChildren: 0.06 } } }} /* 30–80ms, S3 */
>
  {items.map((i) => (
    <motion.li key={i.id} variants={{
      hidden: { opacity: 0, transform: "translateY(8px)" },
      show: { opacity: 1, transform: "translateY(0px)",
              transition: { duration: 0.3, ease: [0.23, 1, 0.32, 1] } },
    }} />
  ))}
</motion.ul>
```

### 5.3 Кинетический заголовок через `clip-path` (WAAPI, вне главного потока)

```js
heading.animate(
  [{ clipPath: "inset(0 0 100% 0)" }, { clipPath: "inset(0 0 0 0)" }],
  { duration: 700, fill: "forwards", easing: "cubic-bezier(0.77, 0, 0.175, 1)" },
);
```

`clip-path: inset(t r b l)` «съедает» с каждой стороны; годится для reveal-on-scroll,
hold-to-delete, бесшовной смены цвета таба, слайдера сравнения. (S3)

## 6. Футер с анимацией

**Честно: ни один из 7 DESIGN.md и ни один скилл не содержит рецепта футера.** Ниже — сборка
из того, что есть: тайминги появления из S5 (видео-кадр), идея тёмной секции из D2, правила
длительности и reduced-motion из S3.

| Приём | Конкретика | Источник |
|---|---|---|
| Тёмная секция футера | `#1c1e54` (для Авроры — затемнённый синий из `--brand-2`), текст `rgb(255 255 255 / .7)`, границы и бордеры карточек `rgb(255 255 255 / .1)`, радиус 6px | D2 |
| Разделитель во всю ширину | `border-bottom: 1px solid` тёмным цветом между секциями | D3 |
| Сжатие на мобильном | футер multi-column → stacked single column; отступ секции 80px+ → 48px | D3, D4 |
| Порядок раскрытия | блоки `translate ±100px` + `scale 1.4→1.0` + `opacity 0→1`, stagger **80ms**, сборка 1.2s → имя 1.4s → tagline 1.8s → нижняя строка | S5 |
| Shimmer одним проходом; свечение марки | `mask-image`-развёртка по логотипу или hairline, **500ms**, один раз; `filter: drop-shadow(0 0 24px <accent>40)` | S5 |
| Нижняя мета-строка | 11px uppercase, `letter-spacing: .16em`, `opacity: .4`, hairline-разделитель (Figma mono 12px uppercase `+.6px`, Supabase 12px uppercase `+1.2px`) | S5, D6, D7 |
| **Не зацикливать** | «вся анимация завершается и freeze — это финальный кадр, не loop» | S5 |

**Адаптация S5 для веба.** Футер собирается как обычно (колонки, ссылки, юр. notice), затем
**один** reveal-момент: колонки появляются волной `stagger 60ms`, `translateY(10px)` + opacity,
350ms `cubic-bezier(0.23, 1, 0.32, 1)`; шиммер проходит по верхней hairline один раз. Триггер —
`whileInView` + `viewport={{ once: true }}`: футер видят часто, но анимация играет один раз (S2).
Ссылки и кнопки — transition 140–200ms; hover-движение закрыть
`@media (hover: hover) and (pointer: fine)`; при `prefers-reduced-motion: reduce` — статичный футер.
Тайминги S5 (1.2s/1.4s/1.8s) буквально **не переносить** — в вебе они нарушают «UI < 300ms» (S3).

## 7. Anti-patterns

**7.1 Из S2 (флагается «жёстко»).** `transition: all` · `scale(0)` или чистый fade без начального
трансформа · `ease-in` в UI · анимация на шорткате, палитре или действии 100+ раз в день ·
UI-длительность > 300ms без причины · `transform-origin: center` у поповера/дропдауна/тултипа ·
`@keyframes` на тостах и тогглах · анимация layout-свойств (`width/height/margin/padding/top/left`) ·
`x`/`y`/`scale` под нагрузкой · обновление CSS-переменной родителя ради трансформа ребёнка ·
отсутствие `prefers-reduced-motion` на движении · незакрытый `:hover` · симметричный тайминг на
press-and-release · «всё сразу» там, где нужен stagger 30–80ms.

**7.2 Из S8 и S7 (AI-tell'ы).** Фиолетово-синие glow-градиенты без продуктовой причины ·
генерические ряды из трёх карточек-фич · огромные скруглённые карточки повсюду · пустые
маркетинговые прилагательные · несогласованные шкалы отступов и кеглей · декоративные эффекты,
не поддерживающие понимание · «взаимозаменяемый SaaS-лейаут», стоковые иконки, блобы.
S7 добавляет: не выдавать неизвестные данные за факт — помечать sample/pending/unavailable
(стыкуется с `docs/product-facts.md`).

**7.3 Из дизайн-систем (светлая тема).**

| Запрет | Источник |
|---|---|
| Настоящий CSS `border` на карточках — только shadow-border; opacity тени не выше .1 | D3 |
| Pill-радиус на главных кнопках и радиус карточек/кнопок 12px+ — только бейджи и теги | D2, D3 |
| 700 на body; 600 — максимум и только для заголовков | D3 |
| Положительный трекинг на display — только минус | D2, D3 |
| Нейтрально-серые тени — тонировать в бренд | D2 |
| Границы толще `1px solid rgb(0 0 0 / .1)` | D4 |
| Сплошные цветные фоны кнопок (в системе Linear) | D1 |
| box-shadow в тёмной теме — глубина только границами | D6 |
| Кегль/вес выше 450 в light-weight системе; цвет в интерфейсном хроме (Figma — только ч/б) | D7 |
| Радуги (>4 оттенков), «PowerPoint-градиенты», неоновые наложения; loop вместо freeze после анимации | S6, S5 |
| Отладочные маркеры в продакшене; `scrub` вместе с `toggleActions` | S4 |

## 8. Что из этого НЕ подходит Авроре

| Что | Почему |
|---|---|
| **Тёмные палитры Linear (`#08090a`), Supabase (`#171717`), градиенты Figma** | Аврора — светлый продукт для юристов и юридических редакций; в `globals.css` зафиксированы `--bg #ffffff` / `--bg-section #f7faff`. Тёмная тема сломала бы весь существующий слой. Берём приёмы (ступени яркости, глубина границами, моно-лейблы), не палитры. (D1, D6, D7) |
| **Тёплые нейтрали Notion (`#f6f5f4`, `#31302e`, `#615d59`) и Cursor (`#f2f1ed`, `#26251e`, `#e6e5e0`)** | У Авроры **холодная** шкала (`#101828`/`#344054`/`#5d6b82` + синий бренд). Тёплые серые рядом с холодным синим дают грязный стык. Из D5 переносима только идея «фон не чисто белый» — и она уже реализована как `--bg-section: #f7faff`. (D4, D5) |
| **Вес 510 из Linear** | Это стоп переменного Inter (`font-variation-settings`). Основной шрифт Авроры — Onest Variable; наличие промежуточных стопов не проверено. (D1) |
| **OpenType `cv01`/`ss03` (Linear), `ss01` (Stripe)** | Фичи Inter и sohne-var; для Onest поддержка не подтверждена — фича молча ничего не сделает. Переносимы `tnum`, `lnum`, `kern`, `liga`. (D1, D2) |
| **Кегли 48–86px и line-height 1.00 (Vercel 48, Notion 64, Cursor 72, Figma 86, Supabase 72)** | Текущий контракт: `--type-h1-size: clamp(1.75rem … 2rem)` = 28–32px, общий `globals.css` у лендинга и приложения. Скачок до 48–72px сломает связь. Разумный шаг — hero 44–56px **в скоупе лендинга**, не трогая `--type-*`. (D1–D7) |
| **line-height 1.00 на русском заголовке** | В источниках англоязычные лендинги. Русские юридические термины длинные, заголовок ломается на 2–3 строки и при 1.00 строки слипаются. Минимум **1.05–1.10**. *(Моё суждение, не цитата.)* |
| **Вес 700 у Notion** | Notion — единственная из 7 систем с 700 в display; остальные пять запрещают. Для плотной типографики вес работает против трекинга. (D4) |
| **Строгая ч/б-дисциплина Figma** | Авроре нужен синий для CTA, статусов и активных состояний. Плюс dashed-фокус как «подпись»: для не-дизайнерской аудитории пунктирная рамка читается как ошибка, а не как фокус. (D7) |
| **Max-width 1920px (Figma), один брейкпоинт 600px (Supabase), сетка Stripe 1080px и её плотная шкала 4–20px** | Лендингу с русским текстом нужен обычный набор брейкпоинтов, а 1920px растянет строку за предел читаемости. У Авроры уже есть 8px-ритм и `--radius-*`; смешивать две шкалы хуже, чем выбрать одну — 1200px это консенсус четырёх систем. (D2, D6, D7) |
| **Тень Stripe `rgb(50 50 93 / .25)`** | Значение принадлежит navy-палитре Stripe; alpha .25 на светлом фоне Авроры будет грязным пятном. Брать приём тонирования, не значение. (D2) |
| **Радиусы Авроры 8/12/16/20/28/36px** | Не «не подходит из референсов», а наоборот: текущая шкала противоречит всем семи системам (4–8px для контролов и карточек) и попадает в AI-tell «огромные скруглённые карточки». Требует пересмотра. (D1–D7, S8) |
| **GSAP ScrollTrigger как код** | В проекте motion 12.42.2; GSAP создаёт второй движок анимации, свой плагин-регистр и свой цикл очистки. Из S4 берём только концепции (§5). (S4) |
| **WebGL/Canvas-жидкость из S6** | Тяжёлый шейдерный фон: стоимость поддержки, риск по FPS и reduced-motion. У Авроры уже есть CSS-аврора, сетка и зерно (`--aurora-opacity`, `--grid-line`, `--grain-opacity`). Не justified. (S6) |
| **`mix-blend-mode: difference` на hero-тексте** | Непредсказуемый контраст поверх градиента — риск по WCAG и по читаемости юридического заголовка. Приемлемо только для декоративного текста. (S6) |
| **Тайминги S5 буквально (1.2s / 1.4s / 1.8s)** | Это кадр видео с фиксированной длительностью; в вебе нарушает «UI < 300ms». См. адаптацию в §6. (S5, S3) |
| **Палитры S5/S6 (Midnight Indigo `#7c5cff`, Aurora Violet `#a78bfa`, Solar Peach)** | Фиолетовые и неоновые схемы; бренд Авроры — синий `#2563ff`, а фиолетово-синий glow прямо назван AI-tell'ом. (S5, S6, S8) |
| **Тёмная секция `#1c1e54` как есть** | Значение фиолетово-синее (Stripe). Взять идею тёмного брендового блока, но вывести цвет из `--brand-2 #1746e8`. (D2) |
| **`chat-motion-overlay` (S10)** | Генератор видео-оверлеев чата для Remotion и шортсов; к лендингу не относится. (S10) |
| **Tailwind-специфичные приёмы и `scroll-scene.tsx` как есть** | Лендинг — CSS Modules; Tailwind 4 установлен, но в лендинге не используется. `scroll-scene.tsx` написан на Tailwind-классах и подключён только к `/scroll-test`. Переиспользовать идею (sticky + прогресс), а не файл. |

## 9. Чего найти не удалось

- Скиллов `motion-frames`, `scroll-*`, `kinetic-*`, `*-animation`, `web-prototype-*` — **нет**.
- **Ни одного скилла и ни одного раздела про футеры.** §6 — реконструкция из S5, D2–D4, S3,
  а не готовый рецепт из источника.
- **Раздела motion в дизайн-системах нет** (кроме Cursor, п.7). Секции: Visual Theme / Color /
  Typography / Components / Layout / Depth / Do-Don't / Responsive / Agent Prompt; отдельных
  `spacing`, `motion`, `voice`, `brand`, `anti-patterns` нет — отступы внутри Layout,
  anti-patterns внутри Do/Don't. Кинетическая типографика описана только в скиллах (S3, S5).
- Не проверено, требует отдельного шага: поддержка `ss01`/`cv01` в Onest Variable; поведение
  шорткатов `x`/`y`/`scale` в motion 12.42.2 по замерам. Скачаны, но вне приоритета и не читались:
  `design-systems/resend`, `design-systems/raycast`.
