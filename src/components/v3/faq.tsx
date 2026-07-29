"use client";

// FAQ v3: те же честные ответы, что и в боевом лендинге, но без вранья про VK:
// «VK — следующая волна», «работает — с Telegram». Первым открыт вопрос про деньги.
import { useId, useState } from "react";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "motion/react";
import { Plus } from "lucide-react";
import { V3Reveal } from "./reveal";

const EASE = [0.22, 1, 0.36, 1] as const;

const ITEMS = [
  {
    q: "Правда бесплатно? В чём подвох?",
    a: "Подвоха нет: на старте платформа полностью бесплатна, без карты и пейволов. Мы сначала растим живую аудиторию, монетизацию придумаем потом — и скажем об этом заранее. Единственное ограничение — честный дневной лимит ИИ-генераций, потому что ИИ стоит денег. Лимит виден в интерфейсе, а не спрятан в справке.",
  },
  {
    q: "Это законно — следить за конкурентами?",
    a: "Мы собираем только открытые данные — то, что видит любой подписчик. Ничего закрытого, никаких персональных данных, никакого парсинга в обход правил. Это то же, что ты можешь посмотреть руками, — просто платформа делает это за тебя и подводит итог.",
  },
  {
    q: "Мои токены соцсетей в безопасности?",
    a: "Токены хранятся только в зашифрованном виде. Ни один пост не уйдёт без твоего ведома: пока автопилот на подтверждении, платформа не публикует ничего, что ты не одобрил.",
  },
  {
    q: "А если пост не выйдет?",
    a: "Публикует сервер, а не твой компьютер — можно закрыть ноутбук. Если сеть не ответила, платформа повторит попытку до 3 раз и напишет тебе в бот: что случилось, что мы уже делаем и нужно ли что-то от тебя. Пост не потеряется и не задвоится.",
  },
  {
    q: "ИИ будет писать как робот?",
    a: "ИИ учится на твоих постах и на том, что реально зашло у тебя и у конкурентов. Он пишет черновик — ты правишь одной кнопкой или руками. Через две недели одобрений без правок можно включить полное доверие. А можно не включать никогда.",
  },
  {
    q: "А VK? Instagram, TikTok, YouTube?",
    a: "Честно: сейчас по-настоящему работает Telegram. VK подключаем в следующей волне — дату назовём заранее, не любим обещать вслепую. Instagram, TikTok и YouTube — позже. Мы лучше сделаем две сети отлично, чем шесть кое-как.",
  },
  {
    q: "Продукт уже работает или это лист ожидания?",
    a: "Работает. Ранний доступ открыт прямо сейчас: подключаешь Telegram-канал, добавляешь конкурентов — и разведка, ИИ и автопилот уже внутри. Даты называем только на одну волну вперёд — так честнее, чем обещать всё и сразу.",
  },
  {
    q: "Я SMM-агентство, у меня 20 клиентов.",
    a: "Соло-режим включён по умолчанию, чтобы не мешать одиночкам. Командный режим — роли, согласования, комментарии — включается одной настройкой. Все клиенты в одном месте, отчёты собираются сами.",
  },
] as const;

export function V3Faq() {
  // Первым открыт вопрос про деньги: главный ответ читается без единого клика
  const [openIdx, setOpenIdx] = useState(0);
  const reduced = useReducedMotion();
  const uid = useId();
  const panelTransition: Transition = { duration: reduced ? 0 : 0.24, ease: EASE };

  return (
    <section
      id="faq"
      aria-labelledby={`${uid}-title`}
      className="border-y-2 border-[var(--ink)] bg-[var(--sheet)] py-20 sm:py-28"
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
          <div className="v3-card mt-8 flex max-w-md items-start gap-3.5 p-5">
            <span className="v3-live-dot mt-1.5" aria-hidden />
            <p className="text-[14.5px] leading-relaxed text-[var(--ink-2)]">
              <span className="font-bold text-[var(--ink)]">Не нашёл ответа?</span> Напиши в
              Telegram — отвечаем сами, без поддержки-робота.
            </p>
          </div>
        </V3Reveal>

        {/* ПРАВО: аккордеон */}
        <V3Reveal delay={0.08}>
          <div className="v3-panel">
            <ul>
              {ITEMS.map((item, i) => {
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
