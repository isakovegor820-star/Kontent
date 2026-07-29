// Сравнение с конкурентами. Данные — живая разведка 8 сервисов (июль 2026),
// включая строку, где выигрываем не мы. Брутализму таблица ложится идеально:
// жёсткие ячейки, чёрные грани, колонка Авроры — жёлтая заливка.
// VK-строка честная: Telegram уже публикует, VK — следующая волна.
import { Check, Minus, X } from "lucide-react";
import { V3Reveal } from "./reveal";

type CellValue = boolean | "partial";
type Cell = { value: CellValue; note?: string };

const SERVICES = ["Аврора", "Metricool", "Buffer", "SMMplanner"] as const;

type Row = { label: string; cells: readonly [Cell, Cell, Cell, Cell] };

const ROWS: readonly Row[] = [
  {
    label: "Telegram + VK",
    cells: [
      { value: "partial", note: "Telegram уже; VK — следующая волна" },
      { value: false },
      { value: false },
      { value: "partial", note: "только VK" },
    ],
  },
  {
    label: "Разведка конкурентов",
    cells: [
      { value: true, note: "полное досье + выводы ИИ" },
      { value: "partial", note: "базовая" },
      { value: false, note: "сам признаёт, что нет" },
      { value: false },
    ],
  },
  {
    label: "ИИ-контент на русском",
    cells: [{ value: true }, { value: "partial" }, { value: "partial" }, { value: "partial" }],
  },
  {
    label: "Темы для видео с хуками",
    cells: [{ value: true }, { value: false }, { value: false }, { value: false }],
  },
  {
    label: "Вечный бесплатный тариф",
    cells: [
      { value: true, note: "без карты" },
      { value: "partial", note: "реклама: 50 постов, справка: 20" },
      { value: false, note: "не пускает из РФ" },
      { value: false, note: "7 дней пробы" },
    ],
  },
  {
    label: "Работает из России",
    cells: [{ value: true }, { value: true }, { value: false }, { value: true }],
  },
  {
    label: "Автопилот: план недели одной кнопкой",
    cells: [{ value: true }, { value: false }, { value: false }, { value: false }],
  },
  // Строка, где выигрываем не мы: признанное поражение делает таблицу данными, а не рекламой
  {
    label: "Instagram, TikTok, YouTube",
    cells: [
      { value: false, note: "позже — сначала две сети отлично" },
      { value: true },
      { value: true },
      { value: true },
    ],
  },
];

const FOOTNOTES = [
  "Из шести западных «бесплатных» сервисов из России реально работают два. Buffer и InSMM не дают зарегистрироваться, Crowdfire закрылся.",
  "Later отменила вечный бесплатный тариф, Planable сделала его разовым — 50 постов навсегда.",
  "VK и Telegram не поддерживает ни один глобальный сервис: у Adobe — ровно шесть западных сетей.",
];

/** Значок ячейки в бордерном квадрате: ✓ зелёный, ~ жёлтый, ✕ пустой */
function Mark({ value }: { value: CellValue }) {
  if (value === true)
    return (
      <span className="flex h-7 w-7 items-center justify-center border-2 border-[var(--ink)] bg-[var(--green)] text-white">
        <Check className="h-4 w-4" strokeWidth={3.5} aria-label="есть" />
      </span>
    );
  if (value === "partial")
    return (
      <span className="flex h-7 w-7 items-center justify-center border-2 border-[var(--ink)] bg-[var(--acc)]">
        <Minus className="h-4 w-4" strokeWidth={3.5} aria-label="частично" />
      </span>
    );
  return (
    <span className="flex h-7 w-7 items-center justify-center border-2 border-[var(--ink)] bg-[var(--sheet)] text-[var(--ink-2)]">
      <X className="h-4 w-4" strokeWidth={3} aria-label="нет" />
    </span>
  );
}

function CellContent({ cell }: { cell: Cell }) {
  return (
    <span className="flex flex-col items-center gap-1.5">
      <Mark value={cell.value} />
      {cell.note && (
        <span className="text-[12px] leading-snug text-[var(--ink-2)]">{cell.note}</span>
      )}
    </span>
  );
}

export function V3Compare() {
  return (
    <section
      id="compare"
      aria-labelledby="v3-compare-title"
      className="border-y-2 border-[var(--ink)] bg-[var(--paper)] py-20 sm:py-28"
    >
      <div className="v3-wrap">
        <V3Reveal className="mx-auto max-w-3xl text-center">
          <p className="v3-kicker v3-kicker--center justify-center">Честно</p>
          <h2
            id="v3-compare-title"
            className="v3-display mt-6 text-[clamp(1.9rem,4.4vw,3.2rem)] leading-[1.04] font-black uppercase"
          >
            Мы протестировали 8 сервисов
          </h2>
          <p className="v3-body mx-auto mt-5 max-w-xl text-[16px]">
            Данные — из нашей разведки, июль 2026. Каждая ячейка проверена руками — включая строку,
            где выигрываем не мы.
          </p>
        </V3Reveal>

        {/* Таблица (md+) */}
        <V3Reveal delay={0.08} className="mt-12 hidden md:block">
          <div className="v3-panel overflow-x-auto">
            <table className="v3-table">
              <caption className="sr-only">
                Сравнение Авроры с Metricool, Buffer и SMMplanner по данным разведки, июль 2026
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="w-[30%] text-left">
                    Что сравниваем
                  </th>
                  {SERVICES.map((name, j) => (
                    <th key={name} scope="col" className={j === 0 ? "v3-col-us" : undefined}>
                      {j === 0 ? `${name} — мы` : name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row) => (
                  <tr key={row.label}>
                    <th scope="row" className="text-left text-[15px] font-bold">
                      {row.label}
                    </th>
                    {row.cells.map((cell, j) => (
                      <td key={SERVICES[j]} className={`text-center ${j === 0 ? "v3-col-us" : ""}`}>
                        <CellContent cell={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </V3Reveal>

        {/* Карточки (мобилка) */}
        <div className="mt-10 space-y-4 md:hidden">
          {ROWS.map((row) => (
            <V3Reveal key={row.label}>
              <div className="v3-card p-5">
                <h3 className="text-[15.5px] font-bold">{row.label}</h3>
                <ul className="mt-3.5 space-y-2">
                  {row.cells.map((cell, j) => (
                    <li
                      key={SERVICES[j]}
                      className={`flex items-center justify-between gap-3 border-2 border-[var(--ink)] px-3 py-2.5 ${
                        j === 0 ? "bg-[var(--acc)]/40" : "bg-[var(--paper)]"
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="text-[14px] font-semibold">
                          {SERVICES[j]}
                          {j === 0 && " — мы"}
                        </span>
                        {cell.note && (
                          <span className="block text-[12px] leading-snug text-[var(--ink-2)]">
                            {cell.note}
                          </span>
                        )}
                      </span>
                      <Mark value={cell.value} />
                    </li>
                  ))}
                </ul>
              </div>
            </V3Reveal>
          ))}
        </div>

        {/* Сноска разведки */}
        <V3Reveal delay={0.06} className="mt-10">
          <div className="v3-card v3-lift p-6">
            <p className="v3-mono text-[11px] font-semibold tracking-[0.12em] text-[var(--ink-2)] uppercase">
              Что ещё показала разведка
            </p>
            <ul className="mt-3 space-y-2">
              {FOOTNOTES.map((fact) => (
                <li key={fact} className="flex gap-2.5 text-[14px] leading-relaxed text-[var(--ink-2)]">
                  <span aria-hidden className="mt-[8px] h-1.5 w-1.5 shrink-0 bg-[var(--ink)]" />
                  {fact}
                </li>
              ))}
            </ul>
            <p className="mt-4 text-[13.5px] leading-relaxed text-[var(--ink-2)]">
              Проверяли руками в июле 2026 года. Сервисы меняются — если что-то стало иначе, напиши
              нам, и мы поправим таблицу.
            </p>
          </div>
        </V3Reveal>
      </div>
    </section>
  );
}
