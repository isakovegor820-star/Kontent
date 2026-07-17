"use client";

// Календарь — центр интерфейса (ТЗ 5.3). /app сразу ведёт туда.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AppIndex() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/app/calendar");
  }, [router]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg">
      <div className="flex flex-col items-center gap-3">
        <div className="skeleton h-10 w-10 rounded-md" />
        <p className="text-[14px] text-text-2">Открываем календарь…</p>
      </div>
    </div>
  );
}
