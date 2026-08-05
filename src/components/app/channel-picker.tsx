"use client";

// Выбор канала — общий для экранов, которые смотрят на ОДИН канал за раз:
// «Конкуренты», «Идеи», «Аналитика».
//
// Почему один компонент, а не три копии: у этих экранов одинаковый вопрос — «про какой
// канал сейчас говорим». Разъедься они по стилю, человек перестанет узнавать элемент.
// Календарь сюда не входит: там вопрос другой — «какие каналы показывать одновременно»,
// это мультивыбор, и это другой компонент.
//
// Идентификатор канала — инициалы, а не обрезанное имя: в узких местах текст режется до
// «Техн…», а два канала на «Т» становятся неразличимы. Лечить тултипом нельзя (NN/g:
// растёт interaction cost, на тач-устройствах подсказки нет). Цвет — второй слой поверх
// букв: по WCAG 1.4.1 (уровень A) цвет не может быть единственным признаком.

import type { RealChannel } from "@/lib/types";
import { channelHue, cn, initials } from "@/lib/utils";

/** Кружок с инициалами канала. Цвет ускоряет узнавание, но смысл несут буквы. */
export function ChannelAvatar({
  title,
  id,
  size = 18,
}: {
  title: string;
  id: number | string;
  size?: number;
}) {
  const hue = channelHue(id);
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-bold"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.5),
        // Светлота у всех каналов одна: иначе оттенок начнёт спорить с цветом статуса поста
        backgroundColor: `oklch(0.92 0.06 ${hue})`,
        color: `oklch(0.42 0.13 ${hue})`,
      }}
      aria-hidden
    >
      {initials(title)}
    </span>
  );
}

export function channelName(ch: RealChannel) {
  return ch.title ?? ch.handle ?? `Канал ${ch.id}`;
}

/**
 * Ряд каналов, выбран ровно один.
 * При одном канале не рисуется вообще — выбирать нечего, а лишний ряд только шумит.
 */
export function ChannelPicker({
  channels,
  value,
  onChange,
  label = "Канал",
  className,
}: {
  channels: RealChannel[];
  value: number | null;
  onChange: (id: number) => void;
  label?: string;
  className?: string;
}) {
  if (channels.length < 2) return null;

  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-[13px] font-semibold text-text-2">{label}</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
        {channels.map((ch) => {
          const on = value === ch.id;
          const name = channelName(ch);
          return (
            <button
              key={ch.id}
              type="button"
              onClick={() => onChange(ch.id)}
              aria-pressed={on}
              className={cn(
                "inline-flex h-11 max-w-[16rem] cursor-pointer items-center gap-2 rounded-xs px-3.5",
                "text-[14px] font-semibold transition-colors duration-200",
                on
                  ? "bg-info-soft text-info-text ring-1 ring-brand/30 ring-inset"
                  : "bg-surface-inset text-text-2 hover:text-text",
              )}
            >
              <ChannelAvatar title={name} id={ch.id} />
              <span className="truncate">{name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Активные Telegram-каналы + выбранный.
 * Выбор ВЫЧИСЛЯЕМ, а не синхронизируем эффектом: каналы приезжают асинхронно, а выбранный
 * мог быть отключён в другой вкладке — при вычислении оба случая разруливаются сами.
 */
export function useChannelChoice(
  channels: RealChannel[],
  picked: number | null,
): { tgChannels: RealChannel[]; channelId: number | null } {
  const tgChannels = channels.filter((c) => c.network === "tg" && c.is_active);
  const channelId =
    picked && tgChannels.some((c) => c.id === picked) ? picked : (tgChannels[0]?.id ?? null);
  return { tgChannels, channelId };
}
