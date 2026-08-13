"use client";

// Секция 5 ТЗ 8.1 — «Сравнение с конкурентами».
// Данные — раздел 2 ТЗ: живые тесты 8 платформ, июль 2026. Каждая ячейка проверена руками.
// Тон — сухой и фактический (ТЗ 7.5). Мы не злорадствуем: показываем, что нашли, и всё.
//
// Вёрстка:
//   md+   — настоящая семантическая <table> (thead/tbody, scope на заголовках).
//           Колонка «Аврора» подсвечена подложкой-оверлеем, а не фоном ячеек:
//           одна скруглённая плашка без швов между строками. Геометрия точная —
//           table-fixed + колонки 28/18/18/18/18 % → подложка ровно на left-28% w-18%.
//   мобилка — та же таблица стопкой карточек: одна карточка на критерий, внутри 4 мини-строки.

import { useId } from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import {
  ArrowRight,
  CalendarCheck,
  Globe,
  Info,
  Radar,
  Send,
  Share2,
  Sparkles,
  Video,
  Wallet,
} from "lucide-react";
import { AuroraBackground } from "@/components/aurora-background";
import { Button } from "@/components/ui/button";
import { Badge, GlassCard, YesNo } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

const EASE = [0.22, 1, 0.36, 1] as const;

/* ----------------------------------------------------------------- ДАННЫЕ */

type RowIcon = React.ComponentType<{ className?: string; strokeWidth?: number }>;

/** Значение ячейки. Подпись — только там, где без неё галочка соврала бы. */
type Cell = { value: boolean | "partial"; note?: string };

type Row = {
  label: string;
  icon: RowIcon;
  /** Порядок жёстко совпадает с SERVICES */
  cells: readonly [Cell, Cell, Cell, Cell];
};

const SERVICES = ["Аврора", "Metricool", "Buffer", "SMMplanner"] as const;

const ROWS: readonly Row[] = [
  {
    label: "Telegram + VK",
    icon: Send,
    cells: [
      // Обе сети публикуют по-настоящему: Telegram — через бота-администратора,
      // VK — через ключ доступа сообщества. Галочка честная, а не рекламная.
      { value: true },
      { value: false },
      { value: false },
      { value: "partial", note: "только VK" },
    ],
  },
  {
    label: "Разведка конкурентов",
    icon: Radar,
    cells: [
      { value: true, note: "полное досье + выводы ИИ" },
      { value: "partial", note: "базовая" },
      { value: false, note: "сам признаёт, что нет" },
      { value: false },
    ],
  },
  {
    label: "ИИ-контент на русском",
    icon: Sparkles,
    cells: [
      { value: true },
      { value: "partial" },
      { value: "partial" },
      { value: "partial" },
    ],
  },
  {
    label: "Темы для видео с хуками",
    icon: Video,
    cells: [{ value: true }, { value: false }, { value: false }, { value: false }],
  },
  {
    label: "Вечный бесплатный тариф",
    icon: Wallet,
    cells: [
      { value: true, note: "без карты" },
      { value: "partial", note: "реклама обещает 50 постов, справка — 20" },
      { value: false, note: "не даёт зарегистрироваться из РФ" },
      { value: false, note: "7 дней пробы" },
    ],
  },
  {
    label: "Работает из России",
    icon: Globe,
    cells: [{ value: true }, { value: true }, { value: false }, { value: true }],
  },
  {
    label: "Автопилот: план недели одной кнопкой",
    icon: CalendarCheck,
    cells: [{ value: true }, { value: false }, { value: false }, { value: false }],
  },
  // Строка, где выигрываем не мы. Таблица со счётом 7:0 читается как реклама и обесценивает
  // остальные шесть строк; признанное поражение — то, что делает её данными.
  {
    label: "Instagram, TikTok, YouTube",
    icon: Share2,
    cells: [
      { value: false, note: "позже — сначала две сети отлично" },
      { value: true },
      { value: true },
      { value: true },
    ],
  },
];

/** Сноска — факты из раздела 2 ТЗ. Только то, что видели своими глазами. */
const FOOTNOTES = [
  "Из шести западных «бесплатных» сервисов из России реально работают два. Buffer и InSMM не дают зарегистрироваться, Crowdfire закрылся.",
  "Later отменила вечный бесплатный тариф, Planable сделала его разовым — 50 постов навсегда.",
  "VK и Telegram не поддерживает ни один глобальный сервис: у Adobe — ровно шесть западных сетей.",
];

/* -------------------------------------------------------------- КИРПИЧИКИ */

/** Иконка критерия — один и тот же чип на десктопе и на мобилке */
function RowChip({ icon: Icon }: { icon: RowIcon }) {
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xs bg-surface-inset text-text-3">
      <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
    </span>
  );
}

/** Расшифровка значков — иначе «частично» читается как загадка */
function LegendItem({ value, label }: { value: boolean | "partial"; label: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-[13px] font-medium text-text-2">
      <YesNo value={value} />
      {label}
    </span>
  );
}

/* --------------------------------------------------------- ТАБЛИЦА (md+) */

function CompareTable({ reduce }: { reduce: boolean }) {
  return (
    <div className="relative mt-12 hidden md:block">
      {/* Свечение по краю выделенной колонки — единственный градиент секции */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-[-14px] left-[27%] z-0 w-[20%] rounded-2xl bg-brand-gradient opacity-[0.18] blur-2xl"
      />
      {/* Подложка колонки «Аврора»: одна плашка на всю высоту — без швов между строками */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-[28%] z-0 w-[18%] rounded-lg bg-info-soft shadow-card ring-1 ring-brand/15 ring-inset"
      />

      <table className="relative z-10 w-full table-fixed border-separate border-spacing-0 text-left">
        <caption className="sr-only">
          Сравнение Авроры с Metricool, Buffer и SMMplanner по данным нашей разведки, июль 2026 года
        </caption>

        {/* Все четыре сервиса — одной ширины. Сравнение честное и на глаз. */}
        <colgroup>
          <col className="w-[28%]" />
          <col className="w-[18%]" />
          <col className="w-[18%]" />
          <col className="w-[18%]" />
          <col className="w-[18%]" />
        </colgroup>

        <thead>
          <tr>
            <th scope="col" className="pb-5 pl-1 align-bottom">
              <span className="sr-only">Что сравниваем</span>
            </th>

            {/* Мы */}
            <th scope="col" className="px-3 pt-7 pb-5 text-center align-bottom">
              <span className="flex flex-col items-center gap-2.5">
                <span className="inline-flex items-center rounded-full bg-brand-gradient px-3 py-1.5 text-[13px] leading-none font-bold text-white shadow-glow">
                  Мы
                </span>
                <span className="text-[19px] leading-none font-extrabold -tracking-[0.02em] text-text">
                  Аврора
                </span>
              </span>
            </th>

            {SERVICES.slice(1).map((name) => (
              <th
                key={name}
                scope="col"
                className="px-3 pt-7 pb-5 text-center align-bottom text-[15px] font-semibold text-text-2"
              >
                {name}
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {ROWS.map((row, i) => (
            <motion.tr
              key={row.label}
              initial={reduce ? false : { opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ duration: 0.45, delay: reduce ? 0 : i * 0.06, ease: EASE }}
            >
              <th scope="row" className="border-t border-line py-5 pr-5 pl-1 align-middle">
                <span className="flex items-center gap-3">
                  <RowChip icon={row.icon} />
                  <span className="text-[16px] leading-snug font-semibold -tracking-[0.01em] text-text">
                    {row.label}
                  </span>
                </span>
              </th>

              {row.cells.map((cell, j) => (
                <td
                  key={SERVICES[j]}
                  className={cn(
                    "border-t px-3 py-5 text-center align-middle",
                    // хайлайт-колонка получает свою, чуть тёплую линию — иначе шов виден
                    j === 0 ? "border-brand/15" : "border-line",
                  )}
                >
                  <span className="flex flex-col items-center gap-2">
                    <YesNo value={cell.value} />
                    {cell.note && (
                      <span className="text-[13px] leading-snug text-text-3">{cell.note}</span>
                    )}
                  </span>
                </td>
              ))}
            </motion.tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------ КАРТОЧКИ (мобилка) */

function CompareCards({ reduce }: { reduce: boolean }) {
  return (
    <div className="mt-10 space-y-3 md:hidden">
      {ROWS.map((row, i) => (
        <motion.div
          key={row.label}
          initial={reduce ? false : { opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-40px" }}
          transition={{ duration: 0.45, delay: reduce ? 0 : i * 0.06, ease: EASE }}
        >
          <GlassCard className="p-5">
            <h3 className="flex items-center gap-3">
              <RowChip icon={row.icon} />
              <span className="text-[16px] leading-snug font-bold -tracking-[0.01em] text-text">
                {row.label}
              </span>
            </h3>

            <ul className="mt-4 space-y-1.5">
              {row.cells.map((cell, j) => {
                const us = j === 0;
                return (
                  <li
                    key={SERVICES[j]}
                    className={cn(
                      "flex items-start justify-between gap-4 rounded-xs px-3 py-2.5",
                      us
                        ? "bg-info-soft ring-1 ring-brand/15 ring-inset"
                        : "bg-surface-inset/50",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        <span
                          className={cn(
                            "text-[15px] leading-none font-semibold",
                            us ? "text-text" : "text-text-2",
                          )}
                        >
                          {SERVICES[j]}
                        </span>
                        {us && (
                          // Тот же градиент действия, что и в шапке таблицы на десктопе:
                          // плоский bg-brand в тёмной теме — яркий фирменный синий и белый текст
                          // на нём даёт 2.98:1.
                          <span className="inline-flex items-center rounded-full bg-brand-gradient px-2 py-1 text-[13px] leading-none font-bold text-white">
                            Мы
                          </span>
                        )}
                      </span>
                      {cell.note && (
                        <span className="mt-1.5 block text-[13px] leading-snug text-text-3">
                          {cell.note}
                        </span>
                      )}
                    </span>

                    <YesNo value={cell.value} />
                  </li>
                );
              })}
            </ul>
          </GlassCard>
        </motion.div>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------- СЕКЦИЯ */

export function Compare() {
  const reduce = Boolean(useReducedMotion());
  const uid = useId();

  return (
    <section
      id="compare"
      aria-labelledby={`${uid}-title`}
      className="relative isolate overflow-hidden bg-bg py-24 sm:py-32"
    >
      <AuroraBackground intensity="section" grid={false} />

      <div className="relative mx-auto max-w-6xl px-5 sm:px-8">
        {/* -------------------------------------------------------- ЗАГОЛОВОК */}
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.5, ease: EASE }}
          className="mx-auto max-w-3xl text-center"
        >
          <Badge tone="brand">Честно</Badge>

          <h2
            id={`${uid}-title`}
            className="display mt-5 text-[34px] text-text sm:text-[44px] lg:text-[52px]"
          >
            Мы протестировали 8 сервисов. Вот что выяснилось.
          </h2>

          <p className="mx-auto mt-6 max-w-xl text-[16px] leading-relaxed text-text-2">
            Данные — из нашей разведки, июль 2026. Каждая ячейка проверена руками — включая две
            строки, где выигрываем не мы.
          </p>

          {/* Расшифровка значков — до таблицы, чтобы не гадать по ходу */}
          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-7 gap-y-3">
            <LegendItem value={true} label="есть" />
            <LegendItem value="partial" label="частично" />
            <LegendItem value={false} label="нет" />
          </div>
        </motion.div>

        {/* ------------------------------------------------------- СРАВНЕНИЕ */}
        <CompareTable reduce={reduce} />
        <CompareCards reduce={reduce} />

        {/* --------------------------------------------------------- СНОСКА */}
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.5, ease: EASE }}
        >
          <GlassCard className="mt-10 p-5 sm:mt-12 sm:p-6">
            <div className="flex gap-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xs bg-surface-inset text-text-3">
                <Info className="h-[18px] w-[18px]" strokeWidth={1.75} />
              </span>

              <div className="min-w-0">
                <p className="text-[15px] font-semibold text-text">Что ещё показала разведка</p>

                <ul className="mt-2.5 space-y-2">
                  {FOOTNOTES.map((fact) => (
                    <li
                      key={fact}
                      className="flex gap-2.5 text-[13px] leading-relaxed text-text-2"
                    >
                      <span
                        aria-hidden
                        className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-text-3"
                      />
                      <span>{fact}</span>
                    </li>
                  ))}
                </ul>

                <p className="mt-4 text-[13px] leading-relaxed text-text-2">
                  Проверяли руками в июле 2026 года. Сервисы меняются — если что-то стало иначе,
                  напиши нам, и мы поправим таблицу.
                </p>
              </div>
            </div>
          </GlassCard>
        </motion.div>

        {/* ------------------------------------------------ ТОЧКА КОНВЕРСИИ */}
        {/* Возражение «чем вы лучше» только что закрыто — значит, нажать надо давать здесь,
            а не через полторы тысячи пикселей в самом низу страницы. */}
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.5, ease: EASE }}
          className="mt-10 flex flex-col items-center gap-4 text-center sm:mt-12"
        >
          <p className="max-w-lg text-[16px] leading-relaxed text-text-2">
            Всё, что отмечено галочкой в нашей колонке, работает прямо сейчас — можно зайти и
            проверить руками, как проверяли мы.
          </p>
          <Link href="/register" data-cta-inline className="w-full rounded-sm sm:w-auto">
            <Button variant="brand" size="lg" tabIndex={-1} className="group w-full sm:w-auto">
              Забрать ранний доступ
              <ArrowRight
                className="h-4 w-4 transition-transform duration-200 ease-[var(--ease-soft)] group-hover:translate-x-0.5"
                strokeWidth={2}
                aria-hidden
              />
            </Button>
          </Link>
        </motion.div>
      </div>
    </section>
  );
}
