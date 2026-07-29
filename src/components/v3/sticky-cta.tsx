"use client";

// Липкая кнопка на мобиле: главное действие всегда под рукой.
// Прячется, когда на экране финальный CTA, — две жёлтые клавиши рядом не нужны.
import { useEffect, useState } from "react";
import Link from "next/link";

export function V3StickyCta() {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const cta = document.getElementById("cta");
    if (!cta) return;
    const io = new IntersectionObserver(([entry]) => setHidden(entry.isIntersecting), {
      rootMargin: "-10% 0px",
    });
    io.observe(cta);
    return () => io.disconnect();
  }, []);

  return (
    <div
      className={`fixed inset-x-0 bottom-0 z-50 border-t-2 border-[var(--ink)] bg-[var(--paper)] p-3 transition-transform duration-200 lg:hidden ${
        hidden ? "translate-y-full" : ""
      }`}
    >
      <Link href="/register" className="v3-btn w-full">
        Забрать ранний доступ
      </Link>
    </div>
  );
}
