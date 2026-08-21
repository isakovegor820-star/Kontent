"use client";

// Entry point follows the project/channel rollout boundary: enabled cohorts land in
// Today, everyone else keeps the established Calendar entry point.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AppIndex() {
  const router = useRouter();

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/today", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const board = await response.json().catch(() => null) as { enabled?: boolean } | null;
        router.replace(response.ok && board?.enabled ? "/app/today" : "/app/calendar");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        router.replace("/app/calendar");
      });
    return () => controller.abort();
  }, [router]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg">
      <div className="flex flex-col items-center gap-3">
        <div className="skeleton h-10 w-10 rounded-md" />
        <p className="text-[14px] text-text-2">Выбираем стартовый экран…</p>
      </div>
    </div>
  );
}
