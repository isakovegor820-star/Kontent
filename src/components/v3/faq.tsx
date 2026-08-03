"use client";

// FAQ v3: честные ответы без обещаний того, чего в продукте пока нет.
import { useId, useState } from "react";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "motion/react";
import { Plus } from "lucide-react";
import { V3Reveal } from "./reveal";

const EASE = [0.22, 1, 0.36, 1] as const;

const LEGACY_PRICING_ITEM = {
  q: "Правда бесплатно? В чём подвох?",
  a: "Подвоха нет: на старте платформа полностью бесплатна, без карты и пейволов. Мы сначала растим живую аудиторию, монетизацию придумаем потом — и скажем об этом заранее. Единственное ограничение — честный дневной лимит ИИ-генераций, потому что ИИ стоит денег. Лимит виден в интерфейсе, а не спрятан в справке.",
} as const;

const ITEMS = [
  {
    q: "Продукт уже работает или это лист ожидания?",
    a: "Работает. После регистрации открывается продукт: можно настроить Telegram-канал, добавить материалы и перейти к рабочему циклу. Будущие платформы не выдаём за готовые — сейчас основной контур Авроры работает с Telegram.",
  },
  {
    q: "Что произойдёт после регистрации?",
    a: "Сначала создаёшь аккаунт по почте и паролю. Затем подключаешь Telegram-канал, добавляешь материалы и задаёшь правила публикации. Пока канал и режим работы не настроены, Аврора ничего не публикует.",
  },
  {
    q: "Можно в любой момент остановить автопилот?",
    a: "Да. Очередь можно поставить на паузу, изменить материал или расписание и вернуть ручное подтверждение. Уже подготовленные черновики при этом не пропадают.",
  },
  {
    q: "Мои токены соцсетей в безопасности?",
    a: "Токены сохраняются в зашифрованном виде и используются для выбранных операций канала. Ручное подтверждение можно оставить включённым, чтобы выпускать только одобренные материалы.",
  },
  {
    q: "ИИ будет писать как робот?",
    a: "Аврора использует прошлые посты как образец подачи, а факты берёт только из добавленных материалов. Перед выпуском черновик сверяется с правилами канала. Ручное подтверждение можно оставить постоянным — автопилот не требует отдавать последнее слово системе.",
  },
  {
    q: "А если пост не выйдет?",
    a: "Публикует сервер, а не твой компьютер — ноутбук можно закрыть. Если сеть не ответила, платформа фиксирует ошибку и показывает статус, чтобы выпуск не потерялся в тишине.",
  },
  {
    q: "Какие данные смотрит разведка?",
    a: "Только открытые публикации, доступные обычному подписчику. Аврора собирает их в рабочее досье и показывает, какие темы и приёмы стоит изучить — без копирования чужого материала.",
  },
  {
    q: "А VK, Instagram, TikTok и YouTube?",
    a: "Сейчас основной рабочий контур — Telegram. Остальные платформы не включаем в оффер, пока не готовы дать тот же уровень управления и контроля.",
  },
] as const;

export function V3Faq({ legacyPricing = false }: { legacyPricing?: boolean }) {
  const [openIdx, setOpenIdx] = useState(0);
  const reduced = useReducedMotion();
  const uid = useId();
  const items = legacyPricing ? [LEGACY_PRICING_ITEM, ...ITEMS] : ITEMS;
  const panelTransition: Transition = { duration: reduced ? 0 : 0.24, ease: EASE };

  return (
    <section
      id="faq"
      aria-labelledby={`${uid}-title`}
      className="v3-editorial-canvas border-y-2 border-[var(--ink)] py-16 sm:py-20"
    >
      <div className="v3-wrap grid gap-12 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16">
        {/* ЛЕВО: заголовок */}
        <V3Reveal className="lg:sticky lg:top-28 lg:self-start">
          <p className="v3-kicker">Без увиливаний</p>
          <h2
            id={`${uid}-title`}
            className="v3-display mt-6 text-[clamp(1.9rem,4.4vw,3.2rem)] leading-[1.04] font-black uppercase"
          >
            Вопросы, которые ты всё равно задашь
          </h2>
          <p className="v3-body mt-5 max-w-md text-[16px]">
            Отвечаем здесь и сразу — до регистрации, до почты, до любых кнопок. Чтобы не пришлось
            искать подвох между строк.
          </p>
          <a
            href="https://t.me/kontenfkv_bot"
            target="_blank"
            rel="noreferrer"
            className="v3-card mt-8 flex max-w-md items-start gap-3.5 p-5 transition-transform hover:-translate-y-0.5"
          >
            <span className="v3-live-dot mt-1.5" aria-hidden />
            <p className="text-[14.5px] leading-relaxed text-[var(--ink-2)]">
              <span className="font-bold text-[var(--ink)]">Не нашёл ответа?</span> Напиши в
              Telegram — отвечаем сами, без поддержки-робота.
            </p>
          </a>
        </V3Reveal>

        {/* ПРАВО: аккордеон */}
        <V3Reveal delay={0.08}>
          <div className="v3-panel">
            <ul>
              {items.map((item, i) => {
                const open = openIdx === i;
                const btnId = `${uid}-q-${i}`;
                const panelId = `${uid}-a-${i}`;
                return (
                  <li
                    key={item.q}
                    className={i > 0 ? "-mt-[2px] border-t-2 border-[var(--ink)]" : ""}
                  >
                    <h3>
                      <button
                        type="button"
                        id={btnId}
                        aria-expanded={open}
                        aria-controls={panelId}
                        onClick={() => setOpenIdx(open ? -1 : i)}
                        className={`group flex w-full cursor-pointer items-center gap-4 px-5 py-5 text-left transition-colors duration-150 sm:px-6 ${
                          open ? "bg-[var(--acc)]" : "bg-[var(--sheet)] hover:bg-[var(--paper)]"
                        }`}
                      >
                        <span className="flex-1 text-[15.5px] leading-snug font-bold sm:text-[16.5px]">
                          {item.q}
                        </span>
                        <span
                          aria-hidden
                          className={`flex h-8 w-8 shrink-0 items-center justify-center border-2 border-[var(--ink)] transition-transform duration-200 ${
                            open ? "rotate-45 bg-[var(--ink)] text-[var(--paper)]" : "bg-[var(--sheet)]"
                          }`}
                        >
                          <Plus className="h-4 w-4" strokeWidth={3} />
                        </span>
                      </button>
                    </h3>
                    <AnimatePresence initial={false}>
                      {open && (
                        <motion.div
                          key="panel"
                          id={panelId}
                          role="region"
                          aria-labelledby={btnId}
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={panelTransition}
                          className="overflow-hidden border-t-2 border-[var(--ink)]"
                        >
                          <p className="v3-body max-w-[64ch] px-5 py-5 text-[15px] sm:px-6 sm:text-[15.5px]">
                            {item.a}
                          </p>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </li>
                );
              })}
            </ul>
          </div>
        </V3Reveal>
      </div>
    </section>
  );
}
