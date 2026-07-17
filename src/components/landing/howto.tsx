"use client";

// Секция 4 ТЗ 8.1 — «Как пользоваться: 3 шага».
// Это ключевое требование владельца: лендинг обязан ОБЪЯСНИТЬ, как пользоваться
// платформой, ДО регистрации (ТЗ 6: «красивый рассказ о продукте до регистрации»,
// ТЗ 8.2: «человек в конце может пересказать, что делает продукт»).
// Поэтому каждый шаг показан не словами, а МАКЕТОМ интерфейса — свёрстанным,
// не картинкой: 0 КБ, без layout shift, живёт в тёмной теме.
// Тон — ТЗ 7.5: просто и дружелюбно, на «ты», без жаргона и панибратства.

import { useId } from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import {
  ArrowRight,
  Bot,
  Check,
  Clock,
  Link2,
  Plus,
  Radar,
  ShieldCheck,
  Sparkles,
  Timer,
} from "lucide-react";
import { AuroraBackground } from "@/components/aurora-background";
import { Logo } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Badge, Divider, GlassCard, TelegramIcon, VkIcon } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

const EASE = [0.22, 1, 0.36, 1] as const;

type StepIcon = React.ComponentType<{ className?: string; strokeWidth?: number }>;

/* ------------------------------------------------------------ РАМКА МАКЕТА */
// Общая «оконная рама» для всех трёх макетов: единый язык — человек понимает,
// что смотрит на один и тот же продукт, а не на три разные картинки.

function MockFrame({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: StepIcon;
  children: React.ReactNode;
}) {
  return (
    <GlassCard strong className="overflow-hidden rounded-xl">
      {/* Шапка окна — как в платформе */}
      <div className="flex items-center gap-2.5 border-b border-line px-5 py-4">
        <Icon className="h-[18px] w-[18px] text-text-3" strokeWidth={1.75} />
        <span className="text-[13px] font-semibold text-text-2">{title}</span>
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </GlassCard>
  );
}

/* ------------------------------------------------- МАКЕТ 1: ПОДКЛЮЧИ КАНАЛ */

// Права бота — дословно то, что человек увидит в Telegram, когда будет делать бота админом.
// Включён ровно один тумблер: это и есть весь ответ на вопрос «что вы сможете в моём канале».
const PERMISSIONS: { label: string; on: boolean }[] = [
  { label: "Публиковать сообщения", on: true },
  { label: "Читать переписку", on: false },
  { label: "Удалять чужое и банить", on: false },
  { label: "Менять описание канала", on: false },
];

function MockConnect() {
  return (
    <MockFrame title="Подключение сетей" icon={Link2}>
      <div className="space-y-3">
        {/* Telegram — уже подключён */}
        <div className="flex items-center gap-3 rounded-sm border border-line bg-surface p-3.5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xs bg-info-soft text-info-text">
            <TelegramIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-bold -tracking-[0.01em] text-text">Кофе и код</p>
            <p className="truncate text-[13px] text-text-3">@coffee_and_code</p>
          </div>
          <Badge tone="success" className="shrink-0">
            <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />
            подключён
          </Badge>
        </div>

        {/* VK — честно: публикации в VK ещё нет. Рисовать здесь живую кнопку «Войти через
            VK ID» значило бы обещать то, чего продукт сегодня не умеет. */}
        <div className="flex items-center gap-3 rounded-sm border border-line bg-surface p-3.5 opacity-70">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xs bg-surface-inset text-text-3">
            <VkIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-bold -tracking-[0.01em] text-text-2">VK</p>
            <p className="truncate text-[13px] text-text-3">Открываем следующей волной</p>
          </div>
          <Badge tone="neutral" className="shrink-0">
            скоро
          </Badge>
        </div>

        {/* ВРЕЗКА ДОВЕРИЯ. Мы просим права админа в чужом канале — страх появляется ровно
            здесь, значит и ответ должен стоять здесь, а не в отдельной секции внизу. */}
        <div className="rounded-sm border border-line bg-surface p-3.5">
          <p className="text-[13px] font-bold text-text">Что бот сможет делать в канале</p>

          <ul className="mt-2.5 space-y-2">
            {PERMISSIONS.map((p) => (
              <li key={p.label} className="flex items-center gap-2.5">
                {/* Тумблер нарисован: включён ровно один */}
                <span
                  aria-hidden
                  className={cn(
                    "flex h-4 w-7 shrink-0 items-center rounded-full p-0.5",
                    p.on ? "justify-end bg-success" : "justify-start bg-surface-inset",
                  )}
                >
                  <span className="h-3 w-3 rounded-full bg-surface shadow-xs" />
                </span>
                <span
                  className={cn(
                    "text-[13px] leading-tight",
                    p.on ? "font-semibold text-text" : "text-text-3",
                  )}
                >
                  {p.label}
                </span>
                <span className="ml-auto shrink-0 text-[13px] font-semibold text-text-3">
                  {p.on ? "вкл" : "выкл"}
                </span>
              </li>
            ))}
          </ul>

          <p className="mt-3 flex gap-2 text-[13px] leading-relaxed text-text-2">
            <ShieldCheck className="mt-px h-4 w-4 shrink-0 text-success-text" strokeWidth={2} aria-hidden />
            Передумал — убрал бота из канала, и доступ пропал мгновенно. Ничего отзывать у нас
            не нужно.
          </p>
        </div>

        {/* Механика из ТЗ 5.2 — платформа сразу показывает, что произойдёт */}
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-sm bg-surface-inset px-3.5 py-3 text-[13px] font-medium text-text-2">
          <span>Твой канал</span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-text-3" strokeWidth={2} aria-hidden />
          <span>сюда встанет пост</span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-text-3" strokeWidth={2} aria-hidden />
          <span className="font-semibold text-success-text">уйдёт сам</span>
        </div>
      </div>
    </MockFrame>
  );
}

/* --------------------------------------------- МАКЕТ 2: ДОБАВЬ КОНКУРЕНТОВ */

function MockCompetitors() {
  return (
    <MockFrame title="Конкуренты" icon={Radar}>
      {/* Поле со вставленной ссылкой + кнопка. Курсор мигает — ссылку только что вставили */}
      <div className="flex gap-2">
        <div className="flex h-12 min-w-0 flex-1 items-center rounded-xs border border-line bg-surface px-4">
          <span className="caret text-[15px] text-text">t.me/svaril_sam</span>
        </div>
        <span className="inline-flex h-12 shrink-0 items-center gap-1.5 rounded-xs bg-text px-4 text-[15px] font-semibold text-bg">
          <Plus className="h-4 w-4" strokeWidth={2.5} aria-hidden />
          Добавить
        </span>
      </div>

      {/* Через час — готовое досье (ТЗ Б4) */}
      <div className="mt-4 rounded-sm border border-line bg-surface p-4">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-inset text-[13px] font-bold text-text-2">
            СС
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-bold -tracking-[0.01em] text-text">Сварил сам</p>
            <p className="truncate text-[13px] text-text-3">@svaril_sam · 24 100 подписчиков</p>
          </div>
          <Badge tone="success" className="shrink-0">
            <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />
            Досье готово
          </Badge>
        </div>

        <Divider className="my-3.5" />

        {/* Вывод ИИ человеческим языком (ТЗ 5.4) — обрезан, как в реальном списке */}
        <div className="flex gap-2.5">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand" strokeWidth={2} aria-hidden />
          <p className="line-2 text-[14px] leading-relaxed text-text-2">
            Растёт на разборах чужих ошибок: посты «как не надо» собирают в 3 раза больше сохранений,
            чем обычные рецепты. Формат — короткое видео, текст на первом кадре. Приём стоит забрать,
            тему бери свою.
          </p>
        </div>
      </div>
    </MockFrame>
  );
}

/* -------------------------------------------- МАКЕТ 3: ПОДТВЕРЖДАЙ ГОТОВОЕ */

function MockBot() {
  return (
    <MockFrame title="Telegram-бот" icon={Bot}>
      {/* Фон чата */}
      <div className="rounded-sm bg-surface-inset p-4">
        <div className="flex gap-3">
          {/* Аватар бота: логотип, обрезанный в кружок */}
          <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full">
            <Logo size={36} />
          </span>

          <div className="min-w-0 flex-1">
            <div className="overflow-hidden rounded-md rounded-tl-[6px] border border-line bg-surface shadow-soft">
              <div className="p-3.5">
                <p className="flex items-center gap-1.5 text-[13px] font-bold text-brand">
                  Аврора
                  <span className="rounded-[5px] bg-surface-inset px-1.5 py-0.5 text-[13px] font-semibold text-text-3">
                    бот
                  </span>
                </p>
                {/* Дословно из ТЗ, приложение В. Эмодзи здесь — часть текста бота, */}
                {/* а не иконка интерфейса: иконки у нас только Lucide. */}
                <p className="mt-1.5 text-[15px] leading-relaxed text-text">
                  🗓 Собрал план на неделю: 5 постов. Посмотри — если всё ок, жми одну кнопку.
                </p>
              </div>

              {/* Инлайн-клавиатура бота. gap-px по фону border — хайрлайны, как в Telegram */}
              <div className="grid grid-cols-2 gap-px border-t border-line bg-line">
                <span className="flex min-h-11 items-center justify-center bg-surface px-3 py-2.5 text-center text-[13px] font-semibold text-brand">
                  Одобрить всё
                </span>
                <span className="flex min-h-11 items-center justify-center bg-surface px-3 py-2.5 text-center text-[13px] font-semibold text-text-2">
                  Посмотреть по одному
                </span>
              </div>
            </div>

            {/* Время и «доставлено» */}
            <div className="mt-1.5 flex items-center gap-1 pl-1 text-text-3">
              <span className="nums text-[13px]">10:00</span>
              <Check className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              <Check className="-ml-2.5 h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            </div>
          </div>
        </div>
      </div>
    </MockFrame>
  );
}

/* ------------------------------------------------------------------- ШАГИ */

type Step = {
  num: string;
  time: string;
  title: string;
  text: string;
  Mock: React.ComponentType;
};

const STEPS: Step[] = [
  {
    num: "1",
    time: "2 минуты",
    title: "Подключи канал",
    text: "Добавляешь нашего бота админом своего Telegram-канала — и всё. Бот получает ровно одно право: публиковать. Читать переписку, удалять чужое и трогать описание он не может. Платформа сразу показывает: вот твой канал → сюда встанет пост → вот так он уйдёт сам.",
    Mock: MockConnect,
  },
  {
    num: "2",
    time: "1 минута",
    title: "Добавь конкурентов",
    text: "Вставляешь ссылки на 2–3 чужих канала. Через час платформа приносит досье: что у них растёт, какие темы и форматы дают результат — и что из этого стоит забрать себе.",
    Mock: MockCompetitors,
  },
  {
    num: "3",
    time: "15 минут в неделю",
    title: "Подтверждай готовые посты",
    text: "Автопилот приносит план на неделю в Telegram-бот. Смотришь, правишь при желании, жмёшь одну кнопку — дальше сервер публикует сам.",
    Mock: MockBot,
  },
];

/* ------------------------------------------------------------------ СЕКЦИЯ */

export function HowTo() {
  const reduced = useReducedMotion();
  const uid = useId();

  return (
    <section
      id="how"
      aria-labelledby={`${uid}-title`}
      className="relative isolate overflow-hidden bg-bg-section py-24 sm:py-32"
    >
      <AuroraBackground intensity="section" grid={false} />

      <div className="relative mx-auto max-w-6xl px-5 sm:px-8">
        {/* --------------------------------------------------- ЗАГОЛОВОК */}
        <motion.header
          initial={reduced ? false : { opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.5, ease: EASE }}
          className="max-w-2xl"
        >
          <Badge tone="brand">Как пользоваться</Badge>

          <h2
            id={`${uid}-title`}
            className="display mt-5 text-[38px] text-text sm:text-[46px] lg:text-[52px]"
          >
            Три шага — и дальше автопилот
          </h2>

          <p className="mt-5 text-[16px] leading-relaxed text-text-2">
            Ничего скачивать и настраивать не нужно. Подключаешь канал, показываешь, за кем следить,
            — и дальше только подтверждаешь готовое.
          </p>
        </motion.header>

        {/* ------------------------------------------------------- ШАГИ */}
        <ol className="mt-16 list-none space-y-20 sm:mt-24 sm:space-y-28 lg:space-y-32">
          {STEPS.map((step, i) => {
            // Чередование: 1 — текст слева, 2 — макет слева, 3 — снова текст слева.
            // На мобиле порядок в DOM (текст → макет) и есть нужный порядок.
            const flip = i % 2 === 1;
            const textFrom = flip ? 30 : -30;
            const mockFrom = flip ? -30 : 30;
            const { Mock } = step;

            return (
              <li key={step.num} className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
                {/* Текст шага */}
                <motion.div
                  initial={reduced ? false : { opacity: 0, x: textFrom }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true, margin: "-80px" }}
                  transition={{ duration: 0.55, ease: EASE }}
                  className={cn("relative min-w-0", flip ? "lg:order-2" : "lg:order-1")}
                >
                  {/* Огромная цифра — стоит за заголовком. Порядок в DOM = порядок отрисовки,
                      поэтому заголовок ложится поверх без всяких z-index. */}
                  <span
                    aria-hidden
                    className="display pointer-events-none absolute -top-6 -left-2 leading-none text-text-3 opacity-[0.15] select-none sm:-top-8 sm:-left-4 text-[clamp(4rem,10vw,8rem)]"
                  >
                    {step.num}
                  </span>

                  <div className="relative">
                    <Badge tone="brand">
                      <Clock className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                      {step.time}
                    </Badge>

                    <h3 className="display mt-4 text-[28px] text-text sm:text-[34px]">
                      {step.title}
                    </h3>

                    <p className="mt-4 max-w-[46ch] text-[16px] leading-relaxed text-text-2">
                      {step.text}
                    </p>
                  </div>
                </motion.div>

                {/* Макет интерфейса */}
                <motion.div
                  initial={reduced ? false : { opacity: 0, x: mockFrom }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true, margin: "-80px" }}
                  transition={{ duration: 0.55, delay: reduced ? 0 : 0.12, ease: EASE }}
                  className={cn("min-w-0", flip ? "lg:order-1" : "lg:order-2")}
                >
                  <Mock />
                </motion.div>
              </li>
            );
          })}
        </ol>

        {/* ------------------------------------------------ ИТОГОВАЯ ПЛАШКА */}
        {/* Здесь у человека пик понимания продукта — и до этой правки ему было некуда нажать:
            единственная точка конверсии стояла в самом низу страницы. Магнит секции (ТЗ 7.2)
            теперь кнопка, а плитка с таймером стала спокойной — двух градиентов быть не может. */}
        <motion.div
          initial={reduced ? false : { opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.5, ease: EASE }}
          className="mt-20 sm:mt-28"
        >
          <GlassCard
            strong
            className="flex flex-col items-start gap-5 rounded-xl p-6 sm:flex-row sm:items-center sm:gap-6 sm:p-8"
          >
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md bg-info-soft text-info-text">
              <Timer className="h-7 w-7" strokeWidth={1.75} aria-hidden />
            </span>

            <div className="min-w-0 flex-1">
              <p className="text-[19px] leading-snug font-extrabold -tracking-[0.02em] text-text sm:text-[23px]">
                Всё. От регистрации до первого запланированного поста — меньше 5 минут.
              </p>
              {/* Честность вместо обещаний (ТЗ 6) */}
              <p className="mt-2 text-[13px] leading-relaxed text-text-2">
                Это не маркетинг — это критерий приёмки из нашего ТЗ.
              </p>
            </div>

            <Link
              href="/register"
              data-cta-inline
              className="w-full shrink-0 rounded-sm sm:w-auto"
            >
              <Button variant="brand" size="lg" tabIndex={-1} className="group w-full">
                Забрать ранний доступ
                <ArrowRight
                  className="h-4 w-4 transition-transform duration-200 ease-[var(--ease-soft)] group-hover:translate-x-0.5"
                  strokeWidth={2}
                  aria-hidden
                />
              </Button>
            </Link>
          </GlassCard>
        </motion.div>
      </div>
    </section>
  );
}
