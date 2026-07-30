import Link from "next/link";

const VARIANTS = [1, 2, 3, 4] as const;

export function VariantSwitcher({ active }: { active: 1 | 2 | 3 | 4 }) {
  return (
    <nav className="av-switcher" aria-label="Временный переключатель вариантов" data-temporary-switcher>
      <span className="av-switcher__label">Сравнение</span>
      {VARIANTS.map((variant) => (
        <Link
          key={variant}
          href={`/variants/${variant}`}
          aria-current={variant === active ? "page" : undefined}
          className="av-switcher__link"
        >
          Вариант {variant}
        </Link>
      ))}
    </nav>
  );
}
