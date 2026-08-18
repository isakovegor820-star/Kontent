"use client";

// «Сегодня» — быстрый вход в работу: /app сразу показывает следующие действия.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AppIndex() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/app/today");
  }, [router]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg">
      <div className="flex flex-col items-center gap-3">
        <div className="skeleton h-10 w-10 rounded-md" />
        <p className="text-[14px] text-text-2">Собираем план на сегодня…</p>
      </div>
    </div>
  );
}
