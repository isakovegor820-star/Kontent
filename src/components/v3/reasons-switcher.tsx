import Link from "next/link";
import type { ReasonsVariant } from "./reasons-variants";

const VARIANTS = [1, 2, 3] as const;

export function ReasonsSwitcher({ active }: { active: ReasonsVariant }) {
  return (
    <nav className="rv-switcher" aria-label="Временный переключатель вариантов блока причин">
      <span>Блок причин</span>
      {VARIANTS.map((variant) => (
        <Link
          href={`/reasons/${variant}#reasons`}
          aria-current={variant === active ? "page" : undefined}
          key={variant}
        >
          Вариант {variant}
        </Link>
      ))}
    </nav>
  );
}
