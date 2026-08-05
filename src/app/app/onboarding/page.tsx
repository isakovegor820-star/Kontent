"use client";

// А3. Мастер первого запуска (ТЗ, приложение А + сценарий Б1).
// Главное действие — дойти до календаря за 5 минут. Поэтому: ни сайдбара, ни лишних
// полей, а на каждом шаге НАГЛЯДНО показано, что происходит (ТЗ 6: «каждая механика
// объясняется в момент использования»; ТЗ 5.2: «вот твой канал → сюда встанет пост →
// вот так он уйдёт сам»).
// Тон — ТЗ 7.5: просто и дружелюбно, на «ты».

import { Fragment, useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clock,
  Plus,
  Radar,
  Timer,
  TriangleAlert,
} from "lucide-react";
import { ChannelPicker, useChannelChoice } from "@/components/app/channel-picker";
import { Wordmark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import {
  Badge,
  EmptyState,
  Field,
  GlassCard,
  Input,
  TelegramIcon,
  VkIcon,
} from "@/components/ui/primitives";
import { useStore } from "@/lib/store";
import type { Network, RealChannel } from "@/lib/types";
import {
  isMeaningfulProfile,
  normalizeProfile,
  PROFILE_FIELDS,
  type ChannelProfile,
} from "@/lib/channel-profile.mjs";
import { cn, initials, weekdayShort } from "@/lib/utils";
import { RUBRICS } from "@/lib/brief";
import {
  onboardingRecoveryKey,
  parseOnboardingRecovery,
  serializeOnboardingRecovery,
  type OnboardingQuizAnswers,
} from "@/lib/onboarding-recovery";

const EASE = [0.22, 1, 0.36, 1] as const;
const TOTAL = 5;

type StepNo = 1 | 2 | 3 | 4 | 5;
const TONES = [
  { id: "friendly", label: "Дружелюбный, на «ты»" },
  { id: "expert", label: "Экспертный и спокойный" },
  { id: "humor", label: "С юмором и самоиронией" },
  { id: "short", label: "Короткий и по делу" },
] as const;

/* ---------------------------------------------------------------- ССЫЛКИ */

const HOST = /^(t\.me|telegram\.me|telegram\.org|vk\.com|vk\.ru|m\.vk\.com)$/i;

/** Грубо достаём канал из ссылки: последний сегмент после «/» или «@». */
function parseLink(raw: string): { name: string; handle: string; network: Network } | null {
  const value = raw.trim();
  if (!value) return null;

  const network: Network = /vk\.(com|ru)/i.test(value) ? "vk" : "tg";
  const path = value.replace(/^https?:\/\//i, "").split("?")[0].split("#")[0];
  const slug = path
    .split(/[^\w.-]+/)
    .filter(Boolean)
    .reverse()
    .find((part) => !HOST.test(part));
  if (!slug) return null;

  // svaril_sam → Svaril Sam. Настоящее имя подтянется вместе с досье.
  const name = slug
    .replace(/[._-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  return {
    name: name || slug,
    handle: network === "vk" ? `vk.com/${slug}` : `@${slug}`,
    network,
  };
}

/** Один и тот же канал вставляют десятком способов — сравниваем по сути. */
function normHandle(handle: string) {
  return handle
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^(www\.)?(t\.me\/|telegram\.me\/|vk\.com\/|vk\.ru\/)/, "")
    .replace(/^@/, "")
    .replace(/\/+$/, "");
}

/* ------------------------------------------------------ ОБЩИЕ ЧАСТИ ШАГА */

function StepHead({
  time,
  title,
  children,
}: {
  time: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <header>
      <Badge tone="brand">
        <Clock className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
        {time}
      </Badge>
      <h1 className="display mt-4 text-[28px] text-text sm:text-[32px]">{title}</h1>
      <p className="mt-3 max-w-[52ch] text-[15px] leading-relaxed text-text-2">{children}</p>
    </header>
  );
}

function SubHead({ children }: { children: React.ReactNode }) {
  return <h2 className="text-[13px] font-semibold text-text-2">{children}</h2>;
}

function StepFooter({
  onBack,
  hint,
  children,
}: {
  onBack?: () => void;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-auto pt-8">
      <div className="flex flex-wrap items-center gap-3">
        {onBack && (
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" strokeWidth={2} aria-hidden />
            Назад
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">{children}</div>
      </div>
      {hint && (
        <p className="mt-3 text-[13px] leading-relaxed text-text-3 sm:text-right">{hint}</p>
      )}
    </div>
  );
}

/* --------------------------------------------------- ШАГ 1: КВИЗ (30 секунд) */
// Быстрые вопросы: ниша, цель, аудитория, форматы. Ответы уходят в content_brief
// (source='quiz') после подключения канала — автопилот сразу знает, о чём писать.

export type QuizAnswers = OnboardingQuizAnswers;

function StepQuiz({
  answers,
  onChange,
  onNext,
}: {
  answers: QuizAnswers;
  onChange: (a: QuizAnswers) => void;
  onNext: () => void;
}) {
  const uid = useId();
  const canNext = answers.niche.trim().length >= 3 && answers.audience.trim().length >= 3;

  function toggleRubric(label: string) {
    const has = answers.rubrics.includes(label);
    onChange({
      ...answers,
      rubrics: has
        ? answers.rubrics.filter((r) => r !== label)
        : [...answers.rubrics, label].slice(0, 6),
    });
  }

  return (
    <>
      <StepHead time="30 секунд" title="Расскажи о канале">
        Три вопроса — и ИИ сразу настроится под тебя. Без этого он пишет наугад.
      </StepHead>

      <div className="mt-7 space-y-5">
        <Field
          label="Твоя ниша"
          htmlFor={`${uid}-niche`}
          hint="О чём канал? Чем конкретнее — тем точнее ИИ."
        >
          <Input
            id={`${uid}-niche`}
            value={answers.niche}
            onChange={(e) => onChange({ ...answers, niche: e.target.value })}
            placeholder="Например: юридические новости для бизнеса"
            autoComplete="off"
          />
        </Field>

        <Field
          label="Кто твой читатель"
          htmlFor={`${uid}-aud`}
          hint="Для кого пишешь? Возраст, роль, боль."
        >
          <Input
            id={`${uid}-aud`}
            value={answers.audience}
            onChange={(e) => onChange({ ...answers, audience: e.target.value })}
            placeholder="Например: предприниматели 30–45, боятся штрафов"
            autoComplete="off"
          />
        </Field>

        <Field
          label="Зачем тебе канал"
          htmlFor={`${uid}-goal`}
          hint="Продажи, экспертность, комьюнити — что угодно."
        >
          <Input
            id={`${uid}-goal`}
            value={answers.goal}
            onChange={(e) => onChange({ ...answers, goal: e.target.value })}
            placeholder="Например: привлекать клиентов на консультации"
            autoComplete="off"
          />
        </Field>

        <div>
          <p className="text-[13px] font-semibold text-text-2">
            Какие форматы нравятся{" "}
            <span className="font-normal text-text-3">(до 6)</span>
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {RUBRICS.map((r) => {
              const active = answers.rubrics.includes(r.label);
              return (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => toggleRubric(r.label)}
                  aria-pressed={active}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-[13px] font-semibold transition-colors",
                    active
                      ? "border-brand bg-info-soft text-info-text"
                      : "border-line bg-surface text-text-3 hover:border-line-strong hover:text-text",
                  )}
                >
                  {r.emoji} {r.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <StepFooter hint="Минимум: ниша и читатель. Остальное можно заполнить потом.">
        <Button variant="brand" size="lg" onClick={onNext} disabled={!canNext}>
          Дальше
          <ArrowRight className="h-4 w-4" strokeWidth={2.5} aria-hidden />
        </Button>
      </StepFooter>
    </>
  );
}

/* ------------------------------------------- ШАГ 2: НАГЛЯДНАЯ МЕХАНИКА (5.2) */
// Три блока со стрелками — дословно обещание ТЗ: «вот твой канал → сюда встанет
// пост → вот так он уйдёт сам». Появляются по очереди, третий тихо пульсирует:
// именно там происходит то, ради чего человек пришёл.

function Flow({ channel }: { channel?: RealChannel }) {
  const reduced = useReducedMotion();

  const name = channel?.title ?? channel?.handle ?? "Твой канал";
  const handle = channel?.handle ?? "@твой_канал";

  const blocks: { caption: string; done?: boolean; body: React.ReactNode }[] = [
    {
      caption: "Вот твой канал",
      body: (
        <div className="flex items-center gap-2.5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-info-soft text-[13px] font-bold text-info-text">
            {initials(name)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[14px] font-bold -tracking-[0.01em] text-text">{name}</p>
            <p className="truncate text-[13px] text-text-3">{handle}</p>
          </div>
        </div>
      ),
    },
    {
      caption: "Сюда встанет пост",
      body: (
        <div className="w-full">
          <div className="grid grid-cols-4 gap-1">
            {[0, 1, 2, 3].map((d) => (
              <span key={d} className="text-center text-[13px] font-semibold text-text-3">
                {weekdayShort(d)}
              </span>
            ))}
          </div>
          <div className="mt-1.5 grid grid-cols-4 gap-1">
            {[0, 1, 2, 3].map((cell) =>
              cell === 2 ? (
                <motion.span
                  key={cell}
                  className="h-7 rounded-[5px] bg-brand"
                  initial={reduced ? false : { opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: reduced ? 0 : 0.6, ease: EASE }}
                />
              ) : (
                <span key={cell} className="h-7 rounded-[5px] bg-surface-inset" />
              ),
            )}
          </div>
        </div>
      ),
    },
    {
      caption: "Вот так он уйдёт сам",
      done: true,
      body: (
        <div className="flex w-full items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xs bg-info-soft text-info-text">
              <TelegramIcon className="h-[18px] w-[18px]" />
            </span>
            <span className="flex h-9 w-9 items-center justify-center rounded-xs bg-info-soft text-info-text">
              <VkIcon className="h-[18px] w-[18px]" />
            </span>
          </div>
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-success-soft text-success-text">
            <Check className="h-4 w-4" strokeWidth={3} aria-hidden />
          </span>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
      {blocks.map((b, i) => (
        <Fragment key={b.caption}>
          {i > 0 && (
            <motion.span
              aria-hidden
              initial={reduced ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3, delay: reduced ? 0 : i * 0.14 - 0.05, ease: EASE }}
              className="flex shrink-0 items-center justify-center self-center"
            >
              <ArrowRight
                className="h-4 w-4 rotate-90 text-text-3 sm:rotate-0"
                strokeWidth={2}
              />
            </motion.span>
          )}

          <motion.div
            initial={reduced ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: reduced ? 0 : i * 0.14, ease: EASE }}
            className="relative flex flex-1 flex-col rounded-md border border-line bg-surface p-3.5 shadow-soft"
          >
            {/* Тихий пульс на финальном блоке: пост ушёл сам, без тебя */}
            {b.done && !reduced && (
              <motion.span
                aria-hidden
                className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-success"
                initial={{ opacity: 0, scale: 1 }}
                animate={{ opacity: [0, 0.5, 0], scale: [1, 1.04, 1.06] }}
                transition={{ duration: 2.6, repeat: Infinity, ease: "easeOut", delay: 1.1 }}
              />
            )}

            <div className="flex min-h-[56px] items-center">{b.body}</div>
            <p
              className={cn(
                "mt-3 text-[13px] font-semibold",
                b.done ? "text-success-text" : "text-text-3",
              )}
            >
              {b.caption}
            </p>
          </motion.div>
        </Fragment>
      ))}
    </div>
  );
}

const BOT_USERNAME = "@kontenfkv_bot";

function connectError(code?: string): string {
  switch (code) {
    case "no_access":
      return `Бот не видит этот канал. Проверь, что добавил ${BOT_USERNAME} администратором.`;
    case "not_admin":
      return "Бот в канале, но без права публикации. Дай ему право «Публикация сообщений».";
    // Канал уже держит другой аккаунт. Говорим что случилось и что делать (ТЗ 7.5),
    // а не прячем за «попробуй ещё раз» — человек иначе будет тыкать кнопку вечно.
    case "taken":
      return "Этот канал уже подключён к другому аккаунту Авроры. Один канал — один аккаунт: так посты не задвоятся. Отключи канал там, где он подключён сейчас, и добавь здесь.";
    case "empty":
      return "Вставь @адрес канала — например, @my_channel.";
    case "unauthorized":
      return "Сессия истекла — зайди заново.";
    default:
      return "Не получилось подключить. Попробуй ещё раз.";
  }
}

// Ошибки подключения VK-сообщества (connect-vk). Токен сообщества — проверяем его
// сразу на живом API, поэтому «не подходит» означает ровно то, что написано.
function connectVkError(code?: string): string {
  switch (code) {
    case "invalid_token":
      return "Ключ не подошёл. Проверь, что создал ключ сообщества (не личный) и включил право «Стена» в «Управление → Работа с API».";
    case "taken":
      return "Это сообщество уже подключено к другому аккаунту Авроры. Одно сообщество — один аккаунт: так посты не задвоятся.";
    case "empty":
      return "Вставь ключ доступа сообщества.";
    case "server":
      return "Сервер не смог зашифровать ключ. Напиши в поддержку — это чинится на нашей стороне.";
    case "unauthorized":
      return "Сессия истекла — зайди заново.";
    default:
      return "Не получилось подключить. Попробуй ещё раз.";
  }
}

function RealChannelRow({ channel }: { channel: RealChannel }) {
  const isVk = channel.network === "vk";
  return (
    <li className="flex items-center gap-3 rounded-sm border border-line bg-surface p-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xs bg-info-soft text-info-text">
        {isVk ? <VkIcon className="h-5 w-5" /> : <TelegramIcon className="h-5 w-5" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-bold -tracking-[0.01em] text-text">
          {channel.title || channel.handle}
        </p>
        <p className="truncate text-[13px] text-text-3">
          {channel.handle ? `@${channel.handle}` : isVk ? "VK" : "Telegram"}
        </p>
      </div>
      <Badge tone="success">
        <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />
        Подключён
      </Badge>
    </li>
  );
}

function StepConnect({ onNext }: { onNext: () => void | Promise<void> }) {
  const s = useStore();
  const [network, setNetwork] = useState<Network>("tg");
  const [handle, setHandle] = useState("");
  const [vkToken, setVkToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [error, setError] = useState<string>();

  const channels = s.realChannels.filter((channel) => channel.is_active);
  const hasTelegram = channels.some((channel) => channel.network === "tg");

  async function continueOnboarding() {
    if (advancing || !hasTelegram) return;
    setAdvancing(true);
    await onNext();
    setAdvancing(false);
  }

  async function connect(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (connecting) return;
    setError(undefined);
    setConnecting(true);

    const res =
      network === "vk"
        ? await s.connectVkChannel(vkToken.trim())
        : await s.connectChannel(handle.trim());

    setConnecting(false);
    if (res.ok) {
      s.toast({
        kind: "success",
        title: `Канал «${res.title ?? (network === "vk" ? "VK" : handle.trim())}» подключён`,
        body: "Теперь сюда можно постить с сервера.",
      });
      setHandle("");
      setVkToken("");

      // Профиль будет извлечён на следующем шаге с явным channelId. Не запускаем
      // неадресную индексацию: при нескольких каналах она могла выбрать чужой канал.
    } else {
      setError(network === "vk" ? connectVkError(res.error) : connectError(res.error));
    }
  }

  function pick(n: Network) {
    if (n === network) return;
    setNetwork(n);
    setError(undefined);
  }

  return (
    <>
      <StepHead time="2 минуты" title="Подключи канал">
        Выбери сеть и добавь доступ — публиковать будет сервер, твой компьютер не нужен.
      </StepHead>

      <div className="mt-7">
        <SubHead>Как это работает</SubHead>
        <div className="mt-3">
          <Flow channel={channels[0]} />
        </div>
      </div>

      <form onSubmit={connect} className="mt-7">
        <SubHead>Твой канал</SubHead>

        {/* Переключатель сети: у TG и VK разные способы подключения */}
        <div className="mt-3 inline-flex rounded-sm border border-line bg-surface p-1">
          {(["tg", "vk"] as const).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => pick(n)}
              aria-pressed={network === n}
              className={cn(
                "flex items-center gap-1.5 rounded-[3px] px-3 py-1.5 text-[13px] font-semibold transition-colors",
                network === n ? "bg-info-soft text-info-text" : "text-text-3 hover:text-text",
              )}
            >
              {n === "vk" ? <VkIcon className="h-4 w-4" /> : <TelegramIcon className="h-4 w-4" />}
              {n === "vk" ? "VK" : "Telegram"}
            </button>
          ))}
        </div>

        {network === "tg" ? (
          <>
            <p className="mt-3 text-[13px] leading-relaxed text-text-3">
              Добавь нашего бота <b className="font-bold text-text">{BOT_USERNAME}</b>{" "}
              администратором своего Telegram-канала с правом публикации — потом вставь сюда @адрес
              канала.
            </p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <Input
                value={handle}
                disabled={connecting}
                placeholder="@my_channel"
                aria-label="Адрес твоего Telegram-канала"
                aria-invalid={error ? true : undefined}
                onChange={(e) => {
                  setHandle(e.target.value);
                  if (error) setError(undefined);
                }}
              />
              <Button
                type="submit"
                variant="solid"
                size="lg"
                loading={connecting}
                className="shrink-0"
              >
                Подключить
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="mt-3 text-[13px] leading-relaxed text-text-3">
              В VK зайди в сообщество → <b className="font-semibold text-text">Управление → Работа с
              API</b> → «Создать ключ» и включи право{" "}
              <b className="font-semibold text-text">«Стена»</b>. Вставь ключ сюда — мы проверим его
              и сами определим сообщество. Ключ шифруется и виден только тебе.
            </p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <Input
                value={vkToken}
                disabled={connecting}
                type="password"
                autoComplete="off"
                placeholder="Ключ доступа сообщества"
                aria-label="Ключ доступа VK-сообщества"
                aria-invalid={error ? true : undefined}
                onChange={(e) => {
                  setVkToken(e.target.value);
                  if (error) setError(undefined);
                }}
              />
              <Button
                type="submit"
                variant="solid"
                size="lg"
                loading={connecting}
                className="shrink-0"
              >
                Подключить
              </Button>
            </div>
          </>
        )}

        {error && (
          <p role="alert" className="mt-2 text-[13px] leading-relaxed font-medium text-danger-text">
            {error}
          </p>
        )}

        {channels.length > 0 && (
          <ul className="mt-4 space-y-2">
            {channels.map((ch) => (
              <RealChannelRow key={ch.id} channel={ch} />
            ))}
          </ul>
        )}
      </form>

      <StepFooter>
        <Button variant="brand" size="lg" onClick={() => void continueOnboarding()} loading={advancing} disabled={!hasTelegram}>
          Дальше
          <ArrowRight className="h-4 w-4" strokeWidth={2.5} aria-hidden />
        </Button>
      </StepFooter>
      {!hasTelegram && (
        <p className="mt-3 text-center text-[13px] text-text-3">
          Для профиля и безопасного автопилота подключи Telegram-канал.
        </p>
      )}
    </>
  );
}

/* ------------------------------------------- ШАГ 3: ПРОФИЛЬ КАНАЛА (невидимая база) */
// ИИ сам читает посты подключённого канала и собирает профиль бизнеса: нишу, темы,
// услуги, цены, тон и табу. Человек только ПРОВЕРЯЕТ — это и есть наполнение базы
// знаний без единой формы «заполни базу» (лид не должен её видеть вообще).
// Канал не прочитался (приватный, постов мало) — короткое интервью из 6 вопросов:
// иначе ИИ вынужден выдумывать факты в постах, а этого мы не допускаем.

// Все поля — строки (topics — через запятую), на сохранении нормализуем в профиль.
type ProfileEdit = Record<(typeof PROFILE_FIELDS)[number]["key"], string>;

const GOAL_CHIPS = ["Продажи", "Личный бренд", "Трафик на сайт", "Комьюнити"];

function StepProfile({
  quiz,
  channelId,
  onBack,
  onNext,
}: {
  quiz: QuizAnswers;
  channelId: number | null;
  onBack: () => void;
  onNext: () => void;
}) {
  const s = useStore();
  const uid = useId();
  const [phase, setPhase] = useState<"loading" | "confirm" | "interview">("loading");
  const [edit, setEdit] = useState<ProfileEdit>({
    niche: "",
    topics: "",
    services: "",
    prices: "",
    audience: "",
    tone: "",
    taboos: "",
    goal: "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!channelId) {
        setPhase("interview");
        return;
      }
      try {
        const r = await fetch("/api/knowledge/extract-profile", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channelId }),
        });
        const d = (await r.json().catch(() => null)) as
          | { ok?: boolean; profile?: ChannelProfile }
          | null;
        if (!alive) return;
        if (r.ok && d?.ok && d.profile) {
          const p = d.profile;
          // Пустые поля дозаполняем из квиза (шаг 1): человек уже отвечал — не спрашиваем дважды.
          setEdit({
            niche: p.niche || quiz.niche,
            topics: (p.topics ?? []).join(", "),
            services: p.services,
            prices: p.prices,
            audience: p.audience || quiz.audience,
            tone: p.tone,
            taboos: p.taboos,
            goal: p.goal || quiz.goal,
          });
          setPhase("confirm");
        } else {
          // Не прочитался (no_posts/no_handle/ai) — честно говорим и спрашиваем сами.
          setEdit((v) => ({ ...v, niche: quiz.niche, audience: quiz.audience, goal: quiz.goal }));
          setPhase("interview");
        }
      } catch {
        if (alive) setPhase("interview");
      }
    })();
    return () => {
      alive = false;
    };
    // Ответы квиза зафиксированы на шаге 1 и здесь уже не меняются.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  const set =
    (k: keyof ProfileEdit) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setEdit((v) => ({ ...v, [k]: e.target.value }));

  // Подтверждение или интервью — в обоих случаях сохраняем как «профиль, проверенный
  // человеком» (profile_edit): его еженедельное авто-обновление уже не перезапишет.
  const save = async () => {
    if (saving) return;
    setSaving(true);
    const profile = normalizeProfile(edit);
    if (!channelId || !isMeaningfulProfile(profile)) {
      s.toast({
        kind: "danger",
        title: "Профиль не сохранён",
        body: channelId ? "Добавь хотя бы нишу или тему канала." : "Выбери активный Telegram-канал.",
      });
      setSaving(false);
      return;
    }
    try {
      const response = await fetch("/api/knowledge/extract-profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId, profile }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean } | null;
      if (!response.ok || !body?.ok) throw new Error("profile_save_failed");
    } catch {
      s.toast({
        kind: "danger",
        title: "Профиль не сохранён",
        body: "Сервер не подтвердил сохранение. Ответы остались на экране — повтори.",
      });
      setSaving(false);
      return;
    }
    setSaving(false);
    onNext();
  };

  if (phase === "loading") {
    return (
      <>
        <StepHead time="20 секунд" title="Читаю твой канал…">
          Смотрю последние посты и собираю профиль: нишу, темы, услуги и цены. Из этого
          буду писать — и не выдумывать факты.
        </StepHead>
        <div className="mt-8 space-y-4" aria-busy="true" aria-label="Читаю канал">
          <div className="skeleton h-12 rounded-lg" />
          <div className="skeleton h-12 rounded-lg" />
          <div className="skeleton h-12 w-2/3 rounded-lg" />
        </div>
      </>
    );
  }

  if (phase === "interview") {
    const goalChips =
      edit.goal && !GOAL_CHIPS.some((g) => g.toLowerCase() === edit.goal.toLowerCase())
        ? [...GOAL_CHIPS, edit.goal]
        : GOAL_CHIPS;
    return (
      <>
        <StepHead time="2 минуты" title="Расскажи о канале сам">
          Не смог прочитать посты — канал приватный или в нём пока мало текста. Ответь на
          шесть вопросов: без этого мне придётся писать без конкретики, потому что цены и
          факты я не выдумываю.
        </StepHead>

        <div className="mt-7 space-y-5">
          <Field label="О чём канал и для кого" htmlFor={`${uid}-about`} hint="Ниша плюс твой читатель.">
            <Input
              id={`${uid}-about`}
              value={edit.niche}
              onChange={set("niche")}
              placeholder="Например: кофейня в центре — для тех, кто разбирается в зёрнах"
              autoComplete="off"
            />
          </Field>
          <Field label="Что предлагаешь" htmlFor={`${uid}-services`} hint="Услуги, продукты, форматы работы.">
            <Input
              id={`${uid}-services`}
              value={edit.services}
              onChange={set("services")}
              placeholder="Например: консультации, курс по обжарке, зёрна под заказ"
              autoComplete="off"
            />
          </Field>
          <Field label="Цены и сроки" htmlFor={`${uid}-prices`} hint="С цифрами — без них посты будут общими.">
            <Input
              id={`${uid}-prices`}
              value={edit.prices}
              onChange={set("prices")}
              placeholder="Например: консультация 3 000 ₽/час, курс — 2 недели"
              autoComplete="off"
            />
          </Field>
          <Field
            label="Чего не обещаешь и о чём не пишешь"
            htmlFor={`${uid}-taboos`}
            hint="Я никогда не выйду за эту границу."
          >
            <Input
              id={`${uid}-taboos`}
              value={edit.taboos}
              onChange={set("taboos")}
              placeholder="Например: не даю скидок, не пишу про политику"
              autoComplete="off"
            />
          </Field>

          <div>
            <p className="text-[13px] font-semibold text-text-2">Зачем тебе канал</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {goalChips.map((g) => {
                const active = edit.goal.toLowerCase() === g.toLowerCase();
                return (
                  <button
                    key={g}
                    type="button"
                    onClick={() => setEdit((v) => ({ ...v, goal: active ? "" : g }))}
                    aria-pressed={active}
                    className={cn(
                      "rounded-full border px-3 py-1.5 text-[13px] font-semibold transition-colors",
                      active
                        ? "border-brand bg-info-soft text-info-text"
                        : "border-line bg-surface text-text-3 hover:border-line-strong hover:text-text",
                    )}
                  >
                    {g}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <p className="text-[13px] font-semibold text-text-2">Как звучать</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {TONES.map((t) => {
                const active = edit.tone === t.label;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setEdit((v) => ({ ...v, tone: active ? "" : t.label }))}
                    aria-pressed={active}
                    className={cn(
                      "rounded-full border px-3 py-1.5 text-[13px] font-semibold transition-colors",
                      active
                        ? "border-brand bg-info-soft text-info-text"
                        : "border-line bg-surface text-text-3 hover:border-line-strong hover:text-text",
                    )}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <StepFooter
          onBack={onBack}
          hint="Когда канал наполнится — я сам подтяну стиль и факты из постов."
        >
          <Button variant="ghost" onClick={onNext}>
            Заполню позже
          </Button>
          <Button
            variant="brand"
            size="lg"
            onClick={save}
            loading={saving}
            disabled={!edit.niche.trim() && !edit.services.trim()}
          >
            Готово
            <ArrowRight className="h-4 w-4" strokeWidth={2.5} aria-hidden />
          </Button>
        </StepFooter>
      </>
    );
  }

  // confirm — профиль извлечён из постов, человек проверяет и правит.
  return (
    <>
      <StepHead time="30 секунд" title="Вот что я понял о твоём канале">
        Прочитал последние посты. Проверь и поправь — из этого я пишу посты и не
        выдумываю факты.
      </StepHead>

      <div className="mt-7 space-y-4">
        {PROFILE_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} htmlFor={`${uid}-${f.key}`} hint={f.hint}>
            <Input
              id={`${uid}-${f.key}`}
              value={edit[f.key]}
              onChange={set(f.key)}
              autoComplete="off"
            />
          </Field>
        ))}
      </div>

      <StepFooter onBack={onBack} hint="Пустое поле — честное «не знаю»: писать буду без него, а не придумаю.">
        <Button variant="brand" size="lg" onClick={save} loading={saving}>
          <Check className="h-4 w-4" strokeWidth={2.5} aria-hidden />
          Верно, дальше
        </Button>
      </StepFooter>
    </>
  );
}

/* ------------------------------------------------ ШАГ 4: КОНКУРЕНТЫ (5.4) */

function StepCompetitors({
  onBack,
  onNext,
  onSkip,
}: {
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
}) {
  const uid = useId();
  const linkId = `${uid}-link`;

  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<string[]>([]);

  // Раньше здесь стоял s.addCompetitor — он клал объект с нулями в localStorage и писал
  // «Собираем досье», хотя никто ничего не собирал: до платформы канал не доезжал вообще.
  // Человек проходил онбординг, добавлял конкурентов и получал пустой экран.
  const add = async () => {
    const parsed = parseLink(link);
    if (!parsed) {
      setError("Вставь ссылку на канал — например, t.me/имя_канала.");
      return;
    }
    if (added.some((h) => normHandle(h) === normHandle(parsed.handle))) {
      setError("Этот канал уже в списке — он ниже. Добавь другой.");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/competitors/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: parsed.handle }),
      });
      const d = (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!d?.ok) {
        const why: Record<string, string> = {
          duplicate: "Этот канал уже добавлен.",
          limit: "Больше не помещается — остальных добавишь потом.",
          private_link: "Это приглашение в закрытый канал. Нужен публичный.",
          bad: "Не похоже на ссылку канала. Например: t.me/имя_канала",
        };
        setError(why[d?.error ?? ""] ?? "Не вышло добавить — попробуй ещё раз.");
        return;
      }
      setAdded((prev) => [parsed.handle, ...prev]);
      setLink("");
      setError(null);
    } catch {
      setError("Нет связи с сервером. Попробуй ещё раз.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* Просим ОДНОГО, а не «2–3»: агент дальше идёт по графу упоминаний сам. Обещать
          «мы найдём твоих конкурентов» из пустоты нельзя — у Telegram нет поиска каналов,
          и свежий канал чаще всего не упоминает никого (проверено на живых). Один живой сосед
          — и дальше находки появляются сами: у юр. канала из одного @made4lawyers выросло шесть. */}
      <StepHead time="1 минута" title="Назови одного конкурента">
        Дальше я сам: посмотрю, на кого он ссылается, проверю каждого и принесу список соседей
        по нише. Одного хватит — но если знаешь ещё, добавь.
      </StepHead>

      <form
        className="mt-7"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Field
          label="Ссылка на чужой канал"
          htmlFor={linkId}
          error={error ?? undefined}
          hint="Ссылка на канал конкурента: Telegram (t.me/...) или VK (vk.com/...). Можно вставить прямо из адресной строки."
        >
          <div className="flex gap-2">
            <Input
              id={linkId}
              value={link}
              onChange={(e) => {
                setLink(e.target.value);
                if (error) setError(null);
              }}
              placeholder="t.me/имя_канала"
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
              aria-invalid={error ? true : undefined}
            />
            <Button variant="solid" className="h-12! shrink-0" loading={busy} disabled={busy}>
              <Plus className="h-4 w-4" strokeWidth={2.5} aria-hidden />
              Добавить
            </Button>
          </div>
        </Field>
      </form>

      {/* Здесь стояло «Не знаешь, с кого начать — вот трое из твоей ниши» с зашитыми
          t.me/svaril_sam, t.me/zerno_k_zernu и vk.com/corner_coffee. Юристу предлагались
          сварка и кофейни — и назывались его нишей. Подсказать мы не можем: ниша станет
          известна только из его же канала, а до этого любой список будет выдумкой. */}

      <div className="mt-6">
        <SubHead>Добавлены</SubHead>
        {added.length === 0 ? (
          <div className="mt-3 rounded-md border border-dashed border-line-strong">
            <EmptyState
              icon={<Radar className="h-5 w-5" strokeWidth={1.75} aria-hidden />}
              title="Пока никого"
              body="Вставь ссылку на один чужой канал из твоей темы — этого хватит, чтобы разведка началась."
            />
          </div>
        ) : (
          <ul className="-mr-1 mt-3 max-h-[232px] space-y-2 overflow-y-auto pr-1">
            {added.map((h) => (
              <li
                key={h}
                className="flex items-center gap-2.5 rounded-sm border border-line bg-surface-2 p-3"
              >
                <Check className="h-4 w-4 shrink-0 text-success-text" strokeWidth={3} aria-hidden />
                <span className="truncate text-[14px] font-semibold text-text">@{normHandle(h)}</span>
                <span className="ml-auto shrink-0 text-[12px] text-text-3">собираю досье</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <StepFooter
        onBack={onBack}
        hint="Можно и без конкурентов, но тогда разведка не заработает — а это главное в платформе."
      >
        <Button variant="ghost" onClick={onSkip}>
          Пропустить
        </Button>
        <Button variant="brand" size="lg" disabled={added.length < 1} onClick={onNext}>
          Дальше
          <ArrowRight className="h-4 w-4" strokeWidth={2.5} aria-hidden />
        </Button>
      </StepFooter>
    </>
  );
}

/* ------------------------------------------------------ ШАГ 5: ЗАВЕРШЕНИЕ */

function StepFinish({
  quiz,
  userId,
  onBack,
}: {
  quiz: QuizAnswers;
  userId: number;
  onBack: () => void;
}) {
  const s = useStore();
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  const finish = async () => {
    if (saving) return;
    setSaving(true);
    const completed = await s.finishOnboarding();
    if (!completed) {
      setSaving(false);
      s.toast({
        kind: "danger",
        title: "Онбординг не завершён",
        body: "Сервер не подтвердил результат. Ответы сохранены в этой учётной записи браузера — повтори.",
      });
      return;
    }
    clearQuizLS(userId);
    s.toast({
      kind: "success",
      title: "Всё готово",
      body: "Календарь ждёт. Первый пост создаётся кликом в день.",
    });
    router.push("/app/calendar");
  };

  return (
    <>
      <StepHead time="готово" title="Профиль канала сохранён">
        Проверь короткое резюме. Аврора завершит настройку только после подтверждения сервера.
      </StepHead>

      <div className="mt-7 grid gap-3 rounded-md border border-line bg-surface-inset p-5 text-[14px] leading-relaxed">
        <p><span className="font-semibold text-text">Ниша:</span> <span className="text-text-2">{quiz.niche || "не указана"}</span></p>
        <p><span className="font-semibold text-text">Аудитория:</span> <span className="text-text-2">{quiz.audience || "не указана"}</span></p>
        <p><span className="font-semibold text-text">Цель:</span> <span className="text-text-2">{quiz.goal || "не указана"}</span></p>
      </div>

      <StepFooter onBack={onBack}>
        <Button variant="brand" size="lg" onClick={() => void finish()} loading={saving}>
          Готово — в календарь
          <ArrowRight className="h-4 w-4" strokeWidth={2.5} aria-hidden />
        </Button>
      </StepFooter>
    </>
  );
}

/* -------------------------------------------------------------- МАСТЕР */

// Ключ localStorage для сохранения прогресса quiz между визитами.
function loadQuizFromLS(
  userId: number,
): { quiz: QuizAnswers; step: StepNo; channelId: number | null } | null {
  try {
    const recovered = parseOnboardingRecovery(localStorage.getItem(onboardingRecoveryKey(userId)));
    if (!recovered) return null;
    return {
      quiz: recovered.quiz,
      step: recovered.step as StepNo,
      channelId: recovered.channelId,
    };
  } catch { return null; }
}

function saveQuizToLS(
  userId: number,
  quiz: QuizAnswers,
  step: StepNo,
  channelId: number | null,
) {
  try {
    localStorage.setItem(
      onboardingRecoveryKey(userId),
      serializeOnboardingRecovery({ quiz, step, channelId }),
    );
  } catch { /* full */ }
}

function clearQuizLS(userId: number) {
  try { localStorage.removeItem(onboardingRecoveryKey(userId)); } catch { /* ok */ }
}

function Wizard({ userId }: { userId: number }) {
  const s = useStore();
  const reduced = useReducedMotion();

  // Восстанавливаем прогресс из localStorage: если юзер закрыл вкладку между шагами,
  // ответы не потеряются.
  const [restored] = useState(() => loadQuizFromLS(userId));
  const [pickedChannelId, setPickedChannelId] = useState<number | null>(
    () => restored?.channelId ?? null,
  );
  const [lockedChannelId, setLockedChannelId] = useState<number | null>(
    () => (restored && restored.step >= 3 ? restored.channelId : null),
  );
  const { tgChannels, channelId } = useChannelChoice(s.realChannels, pickedChannelId);
  const effectiveChannelId = lockedChannelId ?? channelId;
  const [step, setStepRaw] = useState<StepNo>(() => restored?.step ?? 1);
  const [quiz, setQuizRaw] = useState<QuizAnswers>(() => restored?.quiz ?? { niche: "", goal: "", audience: "", rubrics: [] });

  const lockedChannelExists =
    lockedChannelId == null || tgChannels.some((channel) => channel.id === lockedChannelId);
  useEffect(() => {
    if (!s.realReady || s.realError || lockedChannelExists || step < 3) return;
    // Канал из recovery-кэша отключён или больше не принадлежит аккаунту. Возвращаемся
    // к явному выбору и не переносим старый бриф/профиль на первый попавшийся канал.
    const reset = window.setTimeout(() => {
      setLockedChannelId(null);
      setStepRaw(2);
      saveQuizToLS(userId, quiz, 2, channelId);
    }, 0);
    return () => window.clearTimeout(reset);
  }, [channelId, lockedChannelExists, quiz, s.realError, s.realReady, step, userId]);

  // Обёртки: сохраняем в localStorage при каждом изменении.
  const setStep = (v: StepNo) => {
    setStepRaw(v);
    saveQuizToLS(userId, quiz, v, effectiveChannelId);
  };
  const setQuiz = (v: QuizAnswers) => {
    setQuizRaw(v);
    saveQuizToLS(userId, v, step, effectiveChannelId);
  };

  // Сохраняем бриф (source='quiz') после подключения канала.
  const saveBrief = async () => {
    if (!effectiveChannelId) {
      s.toast({ kind: "danger", title: "Канал не выбран", body: "Выбери активный Telegram-канал." });
      return false;
    }
    try {
      const response = await fetch("/api/autopilot/brief", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelId: effectiveChannelId,
          niche: quiz.niche.trim(),
          audience: quiz.audience.trim(),
          goal: quiz.goal.trim(),
          rubrics: quiz.rubrics,
          ready: true,
          source: "quiz",
        }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean } | null;
      if (!response.ok || !body?.ok) throw new Error("brief_save_failed");
      return true;
    } catch {
      s.toast({
        kind: "danger",
        title: "Бриф не сохранён",
        body: "Сервер не подтвердил данные. Ответы остались на этом шаге — повтори.",
      });
      return false;
    }
  };

  return (
    <>
      {/* Прогресс: заполняется scaleX от левого края — только transform, без width */}
      <div
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={TOTAL}
        aria-valuenow={step}
        aria-valuetext={`Шаг ${step} из ${TOTAL}`}
        className="mt-8 flex gap-2"
      >
        {[1, 2, 3, 4, 5].map((n) => (
          <div key={n} className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-inset">
            <motion.div
              className="h-full w-full rounded-full bg-brand-gradient"
              style={{ transformOrigin: "left center" }}
              initial={{ scaleX: 0 }}
              animate={{ scaleX: n <= step ? 1 : 0 }}
              transition={{ duration: reduced ? 0 : 0.5, ease: EASE }}
            />
          </div>
        ))}
      </div>

      <p aria-live="polite" className="mt-3 text-center text-[13px] font-semibold text-text-2">
        Шаг {step} из {TOTAL}
      </p>

      {step === 2 && (
        <ChannelPicker
          channels={tgChannels}
          value={effectiveChannelId}
          onChange={(nextChannelId) => {
            setPickedChannelId(nextChannelId);
            saveQuizToLS(userId, quiz, step, nextChannelId);
          }}
          label="Канал для профиля и автопилота"
          className="mt-5 rounded-md border border-line bg-surface p-4"
        />
      )}

      <GlassCard
        strong
        className="mt-6 flex min-h-[520px] w-full flex-col overflow-hidden rounded-xl p-6 sm:p-8"
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={reduced ? { opacity: 0 } : { opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, x: -24 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="flex flex-1 flex-col"
          >
            {step === 1 && (
              <StepQuiz answers={quiz} onChange={setQuiz} onNext={() => setStep(2)} />
            )}
            {step === 2 && (
              <StepConnect
                onNext={async () => {
                  if (await saveBrief()) {
                    setLockedChannelId(effectiveChannelId);
                    setStep(3);
                  }
                }}
              />
            )}
            {step === 3 && (
              <StepProfile
                quiz={quiz}
                channelId={effectiveChannelId}
                onBack={() => {
                  setLockedChannelId(null);
                  setStep(2);
                }}
                onNext={() => setStep(4)}
              />
            )}
            {step === 4 && (
              <StepCompetitors
                onBack={() => setStep(3)}
                onNext={() => setStep(5)}
                onSkip={() => setStep(5)}
              />
            )}
            {step === 5 && (
              <StepFinish
                quiz={quiz}
                userId={userId}
                onBack={() => setStep(4)}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </GlassCard>
    </>
  );
}

/* ------------------------------------------------ СКЕЛЕТОН ДО ГИДРАЦИИ */

function WizardSkeleton() {
  return (
    <div aria-busy="true">
      <div className="mt-8 flex gap-2" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton h-1.5 flex-1" />
        ))}
      </div>

      <p className="mt-3 text-center text-[13px] font-semibold text-text-3">Открываем мастер…</p>

      <GlassCard
        strong
        className="mt-6 flex min-h-[520px] w-full flex-col overflow-hidden rounded-xl p-6 sm:p-8"
      >
        <div className="skeleton h-6 w-28" aria-hidden />
        <div className="skeleton mt-5 h-8 w-2/3" aria-hidden />
        <div className="skeleton mt-4 h-4 w-full" aria-hidden />
        <div className="skeleton mt-2 h-4 w-4/5" aria-hidden />

        <div className="mt-8 grid gap-2 sm:grid-cols-3" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-[112px]" />
          ))}
        </div>

        <div className="mt-7 space-y-2" aria-hidden>
          <div className="skeleton h-[68px]" />
          <div className="skeleton h-[68px]" />
        </div>

        <div className="mt-auto flex justify-end pt-8" aria-hidden>
          <div className="skeleton h-[52px] w-40" />
        </div>
      </GlassCard>
    </div>
  );
}

/* --------------------------------------------------------------- ЭКРАН */

export default function OnboardingPage() {
  const s = useStore();
  const router = useRouter();

  useEffect(() => {
    if (!s.authReady) return;
    if (s.authError) return;
    if (!s.user) router.replace("/register");
    else if (s.user.onboarded) router.replace("/app/calendar");
  }, [router, s.authReady, s.authError, s.user]);

  const user = s.user;
  const canStart = s.ready && s.authReady && !s.authError && user && !user.onboarded;

  return (
    <main
      id="main"
      className="v3-paper relative isolate flex min-h-dvh flex-col items-center justify-center overflow-hidden px-5 py-10 sm:py-14"
    >
      <div className="relative flex w-full max-w-2xl flex-col">
        <div className="flex justify-center">
          <Wordmark />
        </div>

        {s.ready && s.authReady && s.authError && !user ? (
          <div role="alert" className="mt-8 rounded-md border-2 border-line bg-surface p-6 shadow-card">
            <TriangleAlert className="h-6 w-6 text-fire" aria-hidden />
            <h1 className="display mt-4 text-[26px] text-text">Не удалось проверить вход</h1>
            <p className="mt-2 text-[15px] leading-relaxed text-text-2">
              Сервер сессий временно недоступен. Прогресс мастера не потерян.
            </p>
            <Button className="mt-5" variant="brand" onClick={() => void s.refreshAuth()}>
              Повторить проверку
            </Button>
          </div>
        ) : canStart && user ? (
          <Wizard userId={user.id} />
        ) : (
          <WizardSkeleton />
        )}

        {/* Обещание из ТЗ 5.1 держим на виду весь мастер */}
        <p className="mt-6 flex items-center justify-center gap-1.5 text-[13px] text-text-3">
          <Timer className="h-4 w-4" strokeWidth={1.75} aria-hidden />
          Осталось меньше 5 минут
        </p>
      </div>
    </main>
  );
}
