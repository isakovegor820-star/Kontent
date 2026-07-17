"use client";

// А3. Мастер первого запуска (ТЗ, приложение А + сценарий Б1).
// Главное действие — дойти до календаря за 5 минут. Поэтому: ни сайдбара, ни лишних
// полей, а на каждом шаге НАГЛЯДНО показано, что происходит (ТЗ 6: «каждая механика
// объясняется в момент использования»; ТЗ 5.2: «вот твой канал → сюда встанет пост →
// вот так он уйдёт сам»).
// Тон — ТЗ 7.5: просто и дружелюбно, на «ты».

import { Fragment, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  Clock,
  Laugh,
  Plus,
  Radar,
  Smile,
  Sparkles,
  Timer,
  Zap,
} from "lucide-react";
import { AuroraBackground } from "@/components/aurora-background";
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
import type { Channel, Network, RealChannel } from "@/lib/types";
import { cn, initials, weekdayShort } from "@/lib/utils";

const EASE = [0.22, 1, 0.36, 1] as const;
const TOTAL = 3;

type StepNo = 1 | 2 | 3;
type IconType = React.ComponentType<{ className?: string; strokeWidth?: number }>;

/* --------------------------------------------------------------------- ТОНЫ */
// Пользователь выбирает не абстракцию, а конкретный текст, который увидит в канале:
// под каждым тоном — живой пример. Это и есть «наглядно» из ТЗ.

type ToneId = "friendly" | "expert" | "humor" | "short";

const TONES: { id: ToneId; label: string; match: string; Icon: IconType; preview: string }[] = [
  {
    id: "friendly",
    label: "Дружелюбный, на «ты»",
    match: "дружелюб",
    Icon: Smile,
    preview:
      "Если кофе горчит — дело почти всегда в помоле, а не в зёрнах. Возьми на деление крупнее и завари ещё раз: разница слышна с первого глотка. Расскажешь потом, получилось?",
  },
  {
    id: "expert",
    label: "Экспертный и спокойный",
    match: "эксперт",
    Icon: BookOpen,
    preview:
      "Горечь в чашке — почти всегда переэкстракция: помол слишком мелкий, вода забирает лишнее. Решение простое: одно деление крупнее и пролив короче на двадцать секунд. Проверено на трёх сортах.",
  },
  {
    id: "humor",
    label: "С юмором и самоиронией",
    match: "юмор",
    Icon: Laugh,
    preview:
      "Полгода я винил зёрна, воду, бариста и фазу луны. Виноват был помол. Одно деление крупнее — и кофе перестал горчить, а я перестал считать себя экспертом.",
  },
  {
    id: "short",
    label: "Короткий и по делу",
    match: "коротк",
    Icon: Zap,
    preview:
      "Кофе горчит — помол слишком мелкий.\nСделай на деление крупнее.\nЗавари снова: горечи не будет.",
  },
];

function matchTone(saved: string): ToneId {
  const low = saved.toLowerCase();
  return TONES.find((t) => low.includes(t.match))?.id ?? "friendly";
}

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

/* ------------------------------------------- ШАГ 1: НАГЛЯДНАЯ МЕХАНИКА (5.2) */
// Три блока со стрелками — дословно обещание ТЗ: «вот твой канал → сюда встанет
// пост → вот так он уйдёт сам». Появляются по очереди, третий тихо пульсирует:
// именно там происходит то, ради чего человек пришёл.

function Flow({ channel }: { channel?: Channel }) {
  const reduced = useReducedMotion();

  const name = channel?.name ?? "Твой канал";
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

function RealChannelRow({ channel }: { channel: RealChannel }) {
  return (
    <li className="flex items-center gap-3 rounded-sm border border-line bg-surface p-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xs bg-info-soft text-info-text">
        <TelegramIcon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-bold -tracking-[0.01em] text-text">
          {channel.title || channel.handle}
        </p>
        <p className="truncate text-[13px] text-text-3">
          {channel.handle ? `@${channel.handle}` : "Telegram"}
        </p>
      </div>
      <Badge tone="success">
        <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />
        Подключён
      </Badge>
    </li>
  );
}

function StepConnect({ onNext }: { onNext: () => void }) {
  const s = useStore();
  const [handle, setHandle] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();

  const channels = s.realChannels;

  async function connect(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (connecting) return;
    if (!handle.trim()) {
      setError("Вставь @адрес канала — например, @my_channel.");
      return;
    }
    setError(undefined);
    setConnecting(true);
    const res = await s.connectChannel(handle.trim());
    setConnecting(false);
    if (res.ok) {
      s.toast({
        kind: "success",
        title: `Канал «${res.title ?? handle.trim()}» подключён`,
        body: "Теперь сюда можно постить с сервера.",
      });
      setHandle("");
    } else {
      setError(connectError(res.error));
    }
  }

  return (
    <>
      <StepHead time="2 минуты" title="Подключи канал">
        Добавь нашего бота <b className="font-bold text-text">{BOT_USERNAME}</b> администратором
        своего Telegram-канала с правом публикации — потом вставь сюда @адрес канала. Публиковать
        будет сервер, твой компьютер не нужен.
      </StepHead>

      <div className="mt-7">
        <SubHead>Как это работает</SubHead>
        <div className="mt-3">
          <Flow channel={s.channels[0]} />
        </div>
      </div>

      <form onSubmit={connect} className="mt-7">
        <SubHead>Твой канал</SubHead>
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
          <Button type="submit" variant="solid" size="lg" loading={connecting} className="shrink-0">
            Подключить
          </Button>
        </div>
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
        <Button variant="brand" size="lg" onClick={onNext} disabled={channels.length === 0}>
          Дальше
          <ArrowRight className="h-4 w-4" strokeWidth={2.5} aria-hidden />
        </Button>
      </StepFooter>
      {channels.length === 0 && (
        <p className="mt-3 text-center text-[13px] text-text-3">
          Подключи хотя бы один канал — без него постить некуда.
        </p>
      )}
    </>
  );
}

/* ------------------------------------------------ ШАГ 2: КОНКУРЕНТЫ (5.4) */

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
          hint="Telegram или VK. Можно вставить прямо из адресной строки."
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

/* ------------------------------------------------------ ШАГ 3: ТОН И НИША */

function StepTone({
  niche,
  onNiche,
  tone,
  onTone,
  onBack,
}: {
  niche: string;
  onNiche: (v: string) => void;
  tone: ToneId;
  onTone: (v: ToneId) => void;
  onBack: () => void;
}) {
  const s = useStore();
  const router = useRouter();
  const uid = useId();
  const nicheId = `${uid}-niche`;
  const toneId = `${uid}-tone`;

  const active = TONES.find((t) => t.id === tone) ?? TONES[0];

  const finish = () => {
    // Пустое поле не затираем — пусть ИИ работает с тем, что уже знает
    s.finishOnboarding({ niche: niche.trim() || s.settings.niche, tone: active.label });
    s.toast({
      kind: "success",
      title: "Всё готово",
      body: "Календарь ждёт. Первый пост создаётся кликом в день.",
    });
    router.push("/app/calendar");
  };

  return (
    <>
      <StepHead time="меньше минуты" title="О чём твой контент">
        Это нужно ИИ, чтобы писать твоим голосом, а не как робот.
      </StepHead>

      <div className="mt-7">
        <Field
          label="Твоя ниша"
          htmlFor={nicheId}
          hint="Одной строкой: о чём канал и для кого. Чем конкретнее — тем точнее ИИ."
        >
          <Input
            id={nicheId}
            value={niche}
            onChange={(e) => onNiche(e.target.value)}
            placeholder="Например: кофе, обжарка, домашнее заваривание"
            autoComplete="off"
          />
        </Field>
      </div>

      <div className="mt-6">
        <p id={toneId} className="text-[13px] font-semibold text-text-2">
          Каким тоном писать
        </p>
        <div
          role="radiogroup"
          aria-labelledby={toneId}
          className="mt-3 grid gap-2 sm:grid-cols-2"
        >
          {TONES.map((t) => {
            const selected = t.id === tone;
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onTone(t.id)}
                className={cn(
                  "flex min-h-[52px] cursor-pointer items-center gap-2.5 rounded-sm border px-4 py-3",
                  "text-left text-[15px] font-semibold transition-colors duration-200 ease-[var(--ease-soft)]",
                  selected
                    ? "border-brand bg-info-soft text-text"
                    : "border-line bg-surface text-text-2 hover:border-line-strong hover:text-text",
                )}
              >
                <t.Icon
                  className={cn("h-[18px] w-[18px] shrink-0", selected ? "text-brand" : "text-text-3")}
                  strokeWidth={1.75}
                />
                <span className="min-w-0">{t.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Момент ценности: человек сразу видит СВОЙ будущий пост, а не обещание */}
      <div className="mt-6 rounded-md border border-line bg-surface-inset p-4">
        <p className="flex items-center gap-2 text-[13px] font-semibold text-text-2">
          <Sparkles className="h-4 w-4 text-brand" strokeWidth={2} aria-hidden />
          Так ИИ напишет твой первый пост
        </p>
        <div className="mt-3 min-h-[84px]">
          <AnimatePresence mode="wait" initial={false}>
            <motion.p
              key={active.id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.22, ease: EASE }}
              className="text-[15px] leading-relaxed whitespace-pre-line text-text"
            >
              {active.preview}
            </motion.p>
          </AnimatePresence>
        </div>
      </div>

      <StepFooter onBack={onBack}>
        <Button variant="brand" size="lg" onClick={finish}>
          Готово — в календарь
          <ArrowRight className="h-4 w-4" strokeWidth={2.5} aria-hidden />
        </Button>
      </StepFooter>
    </>
  );
}

/* -------------------------------------------------------------- МАСТЕР */

function Wizard() {
  const s = useStore();
  const reduced = useReducedMotion();

  const [step, setStep] = useState<StepNo>(1);
  // Стор уже гидрирован (мастер рендерится только при s.ready) — читаем настройки сразу
  const [niche, setNiche] = useState(() => s.settings.niche);
  const [tone, setTone] = useState<ToneId>(() => matchTone(s.settings.tone));

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
        {[1, 2, 3].map((n) => (
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
            {step === 1 && <StepConnect onNext={() => setStep(2)} />}
            {step === 2 && (
              <StepCompetitors
                onBack={() => setStep(1)}
                onNext={() => setStep(3)}
                onSkip={() => setStep(3)}
              />
            )}
            {step === 3 && (
              <StepTone
                niche={niche}
                onNiche={setNiche}
                tone={tone}
                onTone={setTone}
                onBack={() => setStep(2)}
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
        {[0, 1, 2].map((i) => (
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

  return (
    <main
      id="main"
      className="relative isolate flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-bg-section px-5 py-10 sm:py-14"
    >
      <AuroraBackground intensity="section" grid grain />

      <div className="relative flex w-full max-w-2xl flex-col">
        <div className="flex justify-center">
          <Wordmark />
        </div>

        {s.ready ? <Wizard /> : <WizardSkeleton />}

        {/* Обещание из ТЗ 5.1 держим на виду весь мастер */}
        <p className="mt-6 flex items-center justify-center gap-1.5 text-[13px] text-text-3">
          <Timer className="h-4 w-4" strokeWidth={1.75} aria-hidden />
          Осталось меньше 5 минут
        </p>
      </div>
    </main>
  );
}
