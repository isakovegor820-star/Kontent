"use client";

// Липкая кнопка на мобиле: главное действие всегда под рукой.
// Прячется на финальной сцене и в футере, чтобы не перекрывать кульминацию.
import { useEffect, useState } from "react";
import Link from "next/link";

export function V3StickyCta() {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const targets = [
      document.getElementById("cta"),
      document.getElementById("finale"),
      document.getElementById("footer"),
    ].filter((target): target is HTMLElement => Boolean(target));
    if (!targets.length) return;

    const visible = new Set<Element>();
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          visible.add(entry.target);
        } else {
          visible.delete(entry.target);
        }
      });
      setHidden(visible.size > 0);
    }, {
      rootMargin: "-10% 0px",
    });
    targets.forEach((target) => io.observe(target));
    return () => io.disconnect();
  }, []);

  return (
    <div
      aria-hidden={hidden}
      className={`v3-sticky-cta fixed inset-x-0 bottom-0 z-50 border-t-2 border-[var(--ink)] bg-[var(--paper)] p-3 transition-transform duration-200 lg:hidden ${
        hidden ? "translate-y-full" : ""
      }`}
    >
      <Link href="/register" className="v3-btn w-full" tabIndex={hidden ? -1 : undefined}>
        Запустить первый цикл
      </Link>
    </div>
  );
}
