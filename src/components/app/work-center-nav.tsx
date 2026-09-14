import Link from "next/link";
import { buttonClassName } from "@/components/ui/button";

export function WorkCenterNav({ current, channelId }: { current: "today" | "growth"; channelId: number | null }) {
  const query = channelId ? `?channel=${channelId}` : "";
  return <nav aria-label="Работа с каналом" className="mb-6 flex flex-wrap gap-2">
    {([
      ["today", "Сегодня"], ["growth", "Цель и результаты"],
    ] as const).map(([key, label]) => <Link key={key} href={`/app/${key}${query}`} aria-current={current === key ? "page" : undefined}
      className={buttonClassName({ variant: current === key ? "secondary" : "ghost", className: "min-h-11" })}>{label}</Link>)}
  </nav>;
}
