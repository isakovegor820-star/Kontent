// Шапка v3: логотип-штамп, моно-меню, жёлтая клавиша.
// Липкая, с жёсткой нижней границей — как полоса пульта.
import Link from "next/link";

const LINKS = [
  { href: "#how", label: "Как это работает" },
  { href: "#compare", label: "Сравнение" },
  { href: "#pricing", label: "Тарифы" },
  { href: "#faq", label: "Вопросы" },
] as const;

export function V3Nav() {
  return (
    <header className="sticky top-0 z-50 border-b-2 border-[var(--ink)] bg-[var(--paper)]">
      <div className="v3-wrap flex h-16 items-center gap-6">
        {/* Логотип-штамп: чёрная рамка, жёлтый угол */}
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          <span
            aria-hidden
            className="flex h-8 w-8 items-center justify-center border-2 border-[var(--ink)] bg-[var(--acc)] font-[family-name:var(--v3-display)] text-[15px] font-black"
          >
            А
          </span>
          <span className="font-[family-name:var(--v3-display)] text-[15px] font-bold tracking-[0.08em] uppercase">
            Аврора
          </span>
        </Link>

        {/* Моно-меню — только на десктопе */}
        <nav aria-label="Разделы лендинга" className="ml-auto hidden items-center gap-6 lg:flex">
          {LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="v3-mono text-[12px] font-medium tracking-[0.08em] text-[var(--ink-2)] uppercase transition-colors duration-150 hover:text-[var(--ink)] hover:underline hover:decoration-2 hover:underline-offset-4"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <Link href="/register" className="v3-btn v3-btn--sm ml-auto lg:ml-0">
          Ранний доступ
        </Link>
      </div>
    </header>
  );
}
