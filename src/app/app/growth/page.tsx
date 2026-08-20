"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Compass, Sparkles } from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { ChannelPicker, useChannelChoice } from "@/components/app/channel-picker";
import { Button, buttonClassName } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import type { GrowthBoard, GrowthConfidence, GrowthMoveRecord } from "@/lib/growth";
import { createWorkspaceRequestFence, isAbortError } from "@/lib/client-workspace-isolation";
import { growthRequestIdentity, isCurrentGrowthRequest } from "@/lib/growth-request-race";
import { useStore } from "@/lib/store";

function confidenceLabel(value: GrowthConfidence): string {
  if (value === "answered") return "Факт";
  if (value === "hypothesis") return "Предположение";
  return "Мало данных";
}

function statusLabel(status: GrowthMoveRecord["status"]): string {
  if (status === "done") return "Сделали";
  if (status === "skipped") return "Пропустили";
  return "Так и висит";
}

export default function GrowthPage() {
  const store = useStore();
  const [picked, setPicked] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const value = Number(new URLSearchParams(window.location.search).get("channel"));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  });
  const { tgChannels, channelId } = useChannelChoice(store.realChannels, picked);
  const [board, setBoard] = useState<GrowthBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [requestFence] = useState(createWorkspaceRequestFence);
  const channelRef = useRef(channelId);

  const load = useCallback(async () => {
    const requestedChannelId = channelRef.current;
    if (!requestedChannelId) {
      requestFence.invalidate();
      setBoard(null);
      setLoadError(false);
      setLoading(false);
      return;
    }
    const ticket = requestFence.start(growthRequestIdentity(requestedChannelId));
    const isCurrent = () => isCurrentGrowthRequest(requestFence, ticket, channelRef.current);
    setLoading(true);
    setLoadError(false);
    try {
      const response = await fetch(`/api/growth?channel=${requestedChannelId}`, {
        method: "POST",
        cache: "no-store",
        signal: ticket.signal,
      });
      const next = (await response.json().catch(() => null)) as GrowthBoard | null;
      if (!response.ok || !next) throw new Error("growth_unavailable");
      if (!isCurrent()) return;
      setBoard(next);
    } catch (error) {
      if (isAbortError(error) || !isCurrent()) return;
      setLoadError(true);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [requestFence]);

  useEffect(() => {
    channelRef.current = channelId;
  }, [channelId]);

  useEffect(() => {
    void load();
    return () => requestFence.invalidate();
  }, [channelId, load, requestFence]);

  async function changeStatus(move: GrowthMoveRecord, action: "skip" | "complete") {
    if (busyId) return;
    setBusyId(move.id);
    try {
      const response = await fetch(`/api/growth/moves/${move.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) throw new Error("update_failed");
      await load();
    } catch {
      store.toast({
        kind: "danger",
        title: "Не удалось сохранить ход",
        body: "Попробуй ещё раз. Статус на сервере не менял.",
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <AppShell
      title="Развитие"
      subtitle="Что сделать на этой неделе, чтобы канал стал сильнее. Без прогноза подписчиков."
    >
      <ChannelPicker
        channels={tgChannels}
        value={channelId}
        onChange={setPicked}
        label="Канал"
        className="mb-6"
      />

      <div className="sr-only" role="status" aria-live="polite">
        {loading
          ? "Загружаем ходы для выбранного канала."
          : loadError
            ? "Не удалось загрузить развитие."
            : board?.hasChannel
              ? `Ходы загружены: ${board.moves.length}.`
              : ""}
      </div>

      {loading && (
        <div className="space-y-4">
          <div className="skeleton h-24 w-full rounded-md" />
          <div className="skeleton h-40 w-full rounded-md" />
        </div>
      )}

      {!loading && loadError && (
        <Card>
          <EmptyState
            icon={<Compass className="h-6 w-6" aria-hidden />}
            title="Не удалось загрузить развитие"
            body="Сервер сейчас не отдал диагноз. Ничего не выдумываю."
            action={
              <Button variant="solid" size="sm" onClick={() => void load()}>
                Попробовать снова
              </Button>
            }
          />
        </Card>
      )}

      {!loading && !loadError && (!channelId || (board && !board.hasChannel)) && (
        <Card>
          <EmptyState
            icon={<Compass className="h-6 w-6" aria-hidden />}
            title="Сначала нужен канал"
            body="Подключи Telegram-канал — без него сравнивать нечего."
            action={
              <Link href="/app/onboarding" className={buttonClassName({ variant: "solid", size: "sm" })}>
                К подключению
              </Link>
            }
          />
        </Card>
      )}

      {!loading && !loadError && board?.hasChannel && (
        <div className="space-y-8">
          <section aria-labelledby="growth-diagnosis-heading">
            <h2 id="growth-diagnosis-heading" className="text-[20px] font-bold leading-tight text-text">
              Что сейчас слабо
            </h2>
            {board.diagnosis.length === 0 ? (
              <p className="mt-3 max-w-[68ch] text-[15px] leading-relaxed text-text-2">
                Явных разрывов нет. {board.gaps[0] ?? "Добавь конкурентов или разбор сайта — диагноз станет точнее."}
              </p>
            ) : (
              <ul className="mt-4 space-y-3">
                {board.diagnosis.map((item) => (
                  <li key={item.id}>
                    <Card>
                      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
                        <p className="max-w-[68ch] text-[15px] leading-relaxed text-text">{item.text}</p>
                        <Badge>{confidenceLabel(item.confidence)}</Badge>
                      </div>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
            {board.gaps.length > 0 && board.diagnosis.length > 0 && (
              <p className="mt-3 max-w-[68ch] text-[13px] leading-relaxed text-text-3">
                {board.gaps.join(" ")}
              </p>
            )}
          </section>

          <section aria-labelledby="growth-moves-heading">
            <h2 id="growth-moves-heading" className="text-[20px] font-bold leading-tight text-text">
              Три хода на неделю
            </h2>
            <p className="mt-1 max-w-[68ch] text-[14px] leading-relaxed text-text-3">
              Неделя с {board.weekStart}. Набор не прыгает каждый час.
            </p>
            {board.moves.length === 0 ? (
              <p className="mt-4 max-w-[68ch] text-[15px] leading-relaxed text-text-2">
                Пока нечего поручить. Когда появятся конкуренты, залёты или разбор сайта — здесь будут дела.
              </p>
            ) : (
              <ol className="mt-4 space-y-4">
                {board.moves.map((move, index) => (
                  <li key={move.id}>
                    <Card>
                      <div className="space-y-3 p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[13px] font-semibold text-text-3">{index + 1}</span>
                          <h3 className="text-[16px] font-semibold text-text">{move.title}</h3>
                          <Badge>{confidenceLabel(move.confidence)}</Badge>
                          {move.status !== "open" && <Badge>{statusLabel(move.status)}</Badge>}
                        </div>
                        <p className="max-w-[68ch] text-[14px] leading-relaxed text-text-2">{move.reason}</p>
                        {move.status === "open" && (
                          <div className="flex flex-wrap gap-2">
                            <Link
                              href={move.actionHref}
                              className={buttonClassName({ variant: "brand", size: "sm" })}
                              aria-label={`Сделать ход: ${move.title}`}
                            >
                              <Sparkles className="h-4 w-4" aria-hidden />
                              Сделать
                            </Link>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busyId !== null}
                              loading={busyId === move.id}
                              aria-label={`Пропустить ход: ${move.title}`}
                              onClick={() => void changeStatus(move, "skip")}
                            >
                              Пропустить
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busyId !== null}
                              loading={busyId === move.id}
                              aria-label={`Отметить ход сделанным: ${move.title}`}
                              onClick={() => void changeStatus(move, "complete")}
                            >
                              Сделали
                            </Button>
                          </div>
                        )}
                      </div>
                    </Card>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section aria-labelledby="growth-previous-heading">
            <h2 id="growth-previous-heading" className="text-[20px] font-bold leading-tight text-text">
              Что было на прошлой неделе
            </h2>
            {board.previousMoves.length === 0 ? (
              <p className="mt-3 max-w-[68ch] text-[15px] leading-relaxed text-text-2">
                Прошлой недели ещё нет — появится после следующей.
              </p>
            ) : (
              <ul className="mt-4 space-y-2">
                {board.previousMoves.map((move) => (
                  <li key={move.id} className="flex flex-wrap items-baseline justify-between gap-3 text-[14px]">
                    <span className="text-text">{move.title}</span>
                    <span className="text-text-3">{statusLabel(move.status)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </AppShell>
  );
}
