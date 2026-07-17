"use client";

// Бриф контента (ТЗ Д.9). Без него автопилот писал наугад: в ИИ уходила заглушка
// «Полезный совет по твоей теме», и модель выдумывала что угодно. Здесь человек
// один раз объясняет, что за канал, — и дальше все посты идут по делу.
//
// Честность: платформа может прочитать открытую страницу канала и ПРЕДЛОЖИТЬ бриф,
// но сохраняет его только человек, глазами проверив каждое поле.

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Loader2, Sparkles, Wand2 } from "lucide-react";
import { AppShell } from "@/components/app/shell";
import { Button } from "@/components/ui/button";
import { Card, Field, Input, Textarea } from "@/components/ui/primitives";
import { useStore } from "@/lib/store";
import { EMPTY_BRIEF, briefComplete, type Brief } from "@/lib/brief";
import { cn, plural } from "@/lib/utils";

interface Rubric {
  key: string;
  label: string;
  emoji: string;
}

function BriefInner() {
  // Какой канал настраиваем — приходит из «Автопилота» адресом. Нет параметра (открыли
  // ссылку напрямую) — сервер возьмёт самый ранний канал, и это тот же канал, что покажет
  // «Автопилот» по умолчанию.
  const channelId = Number(useSearchParams().get("channel")) || null;
  const s = useStore();
  const router = useRouter();
  const [brief, setBrief] = useState<Brief>(EMPTY_BRIEF);
  const [rubrics, setRubrics] = useState<Rubric[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const [fromAi, setFromAi] = useState(false); // бриф на экране предложен ИИ и ещё не сохранён
  const [thin, setThin] = useState(false); // постов было мало — догадка слабая

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/autopilot/brief${channelId ? `?channel=${channelId}` : ""}`, {
        cache: "no-store",
      });
      const d = (await r.json()) as { brief?: Brief; rubrics?: Rubric[] };
      if (d.brief) setBrief(d.brief);
      if (d.rubrics) setRubrics(d.rubrics);
    } catch {
      /* сеть */
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- загрузка при монтировании
    load();
  }, [load]);

  const set = <K extends keyof Brief>(k: K, v: Brief[K]) => setBrief((b) => ({ ...b, [k]: v }));

  const toggleRubric = (label: string) =>
    setBrief((b) => ({
      ...b,
      rubrics: b.rubrics.includes(label)
        ? b.rubrics.filter((r) => r !== label)
        : [...b.rubrics, label],
    }));

  // Платформа читает открытую страницу канала и предлагает бриф. Не сохраняет.
  const readChannel = async () => {
    if (reading) return;
    setReading(true);
    try {
      const r = await fetch("/api/autopilot/brief/suggest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId }),
      });
      const d = (await r.json().catch(() => null)) as
        | { ok?: boolean; error?: string; brief?: Brief; readPosts?: number; channelTitle?: string }
        | null;

      if (d?.ok && d.brief) {
        const n = d.readPosts ?? 0;
        setBrief((b) => ({ ...d.brief!, ready: b.ready }));
        setFromAi(true);
        setThin(n < 3); // мало постов — догадка слабая, честно скажем
        s.toast({
          kind: n < 3 ? "info" : "success",
          title: `Прочитал ${n} ${plural(n, "пост", "поста", "постов")}`,
          body:
            n < 3
              ? "Постов в канале мало, так что я мог понять неточно. Проверь поля внимательно и поправь."
              : "Вот что понял про твой канал. Проверь каждое поле и поправь — сохранится только то, что подтвердишь.",
        });
        return;
      }

      // Честно объясняем, почему не вышло, — и зовём заполнить руками.
      const why: Record<string, string> = {
        no_channel: "Сначала подключи Telegram-канал — читать пока нечего.",
        not_readable:
          "Не смог прочитать канал: он закрытый или постов в нём слишком мало. Заполни поля руками — это займёт минуту.",
        unavailable: "ИИ-движок сейчас недоступен. Заполни поля руками или попробуй позже.",
        unparsable: "ИИ ответил непонятно. Попробуй ещё раз или заполни руками.",
        limit: "На сегодня лимит генераций исчерпан. Заполни руками или вернись завтра.",
      };
      s.toast({
        kind: "danger",
        title: "Не вышло прочитать канал",
        body: why[d?.error ?? ""] ?? "Что-то пошло не так. Заполни поля руками.",
      });
    } finally {
      setReading(false);
    }
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const r = await fetch("/api/autopilot/brief", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...brief, ready: true, channelId }),
      });
      const d = (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (d?.ok) {
        s.toast({
          kind: "success",
          title: "Настройка сохранена",
          body: "Теперь автопилот знает, о чём твой канал. Можно собирать план недели.",
        });
        router.push("/app/autopilot");
        return;
      }
      s.toast({
        kind: "danger",
        title: "Не сохранил",
        body:
          d?.error === "incomplete"
            ? "Заполни хотя бы «о чём канал» и «для кого» — без этого ИИ снова начнёт выдумывать."
            : "Что-то пошло не так, попробуй ещё раз.",
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <AppShell title="Настройка автопилота">
        <div className="space-y-4">
          <div className="skeleton h-28 rounded-lg" />
          <div className="skeleton h-64 rounded-lg" />
        </div>
      </AppShell>
    );
  }

  const complete = briefComplete(brief);

  return (
    <AppShell
      title="Настройка автопилота"
      subtitle="Объясни один раз, что за канал, — и автопилот перестанет писать наугад. Правится в любой момент."
      action={
        <Link href="/app/autopilot">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4" aria-hidden />
            К автопилоту
          </Button>
        </Link>
      }
    >
      <div className="space-y-5">
        {/* Быстрый путь: пусть платформа сама прочитает канал */}
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
          <div className="min-w-0">
            <p className="text-[15px] font-bold text-text">Заполнить за меня</p>
            <p className="mt-0.5 text-[13px] leading-relaxed text-text-3">
              Прочитаю открытые посты твоего канала и предложу бриф. Ты проверишь и поправишь —
              без твоего «сохранить» ничего не запишется.
            </p>
          </div>
          <Button variant="brand" onClick={readChannel} loading={reading} disabled={reading}>
            <Wand2 className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />
            Прочитать мой канал
          </Button>
        </Card>

        {fromAi && (
          <div className="flex items-start gap-3 rounded-lg bg-info-soft p-4">
            <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-brand" aria-hidden />
            <p className="text-[14px] leading-relaxed text-text-2">
              <span className="font-semibold text-text">Это черновик от ИИ. </span>
              {thin
                ? "В канале пока мало постов, поэтому я мог понять неточно — проверь особенно внимательно. "
                : "Он мог понять что-то не так — прочитай поля глазами и поправь. "}
              Сохранится только то, что ты подтвердишь кнопкой внизу.
            </p>
          </div>
        )}

        {/* 1. Главное — без этого ИИ снова начнёт выдумывать */}
        <Section n={1} title="О чём канал и для кого" required>
          <Field
            label="О чём канал"
            htmlFor="brief-niche"
            required
            hint="Конкретно, одной фразой. Чем точнее — тем точнее посты."
          >
            <Input
              id="brief-niche"
              value={brief.niche}
              onChange={(e) => set("niche", e.target.value)}
              placeholder="Например: кофе, обжарка, домашнее заваривание"
              autoComplete="off"
            />
          </Field>
          <Field
            label="Для кого"
            htmlFor="brief-audience"
            required
            hint="Кто твой читатель и что он уже умеет."
          >
            <Input
              id="brief-audience"
              value={brief.audience}
              onChange={(e) => set("audience", e.target.value)}
              placeholder="Например: новички, которые варят кофе дома и хотят вкуснее"
              autoComplete="off"
            />
          </Field>
        </Section>

        {/* 2. Рубрики — формат постов, которые чередуем */}
        <Section n={2} title="Рубрики" hint="Форматы, которые автопилот будет чередовать. Не выбрал — подберу сам.">
          <div className="flex flex-wrap gap-2">
            {rubrics.map((r) => {
              const on = brief.rubrics.includes(r.label);
              return (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => toggleRubric(r.label)}
                  aria-pressed={on}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-semibold transition-colors",
                    on
                      ? "border-brand bg-info-soft text-brand"
                      : "border-line bg-surface-inset text-text-2 hover:border-brand/40",
                  )}
                >
                  <span aria-hidden>{r.emoji}</span>
                  {r.label}
                  {on && <Check className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />}
                </button>
              );
            })}
          </div>
          <p className="text-[13px] text-text-3">
            {brief.rubrics.length > 0
              ? `Выбрано ${brief.rubrics.length} ${plural(brief.rubrics.length, "рубрика", "рубрики", "рубрик")}`
              : "Ни одной не выбрано — автопилот подберёт формат сам"}
          </p>
        </Section>

        {/* 3. Зачем всё это */}
        <Section n={3} title="Цель канала">
          <Field label="Зачем ведёшь канал" htmlFor="brief-goal" hint="Что для тебя успех.">
            <Input
              id="brief-goal"
              value={brief.goal}
              onChange={(e) => set("goal", e.target.value)}
              placeholder="Например: собрать своих людей и продавать зерно без рекламы"
              autoComplete="off"
            />
          </Field>
          <Field
            label="Куда ведёшь читателя"
            htmlFor="brief-cta"
            hint="Что читатель должен сделать. Пусто — постов-продажников не будет."
          >
            <Input
              id="brief-cta"
              value={brief.cta}
              onChange={(e) => set("cta", e.target.value)}
              placeholder="Например: в бот-магазин за зерном"
              autoComplete="off"
            />
          </Field>
        </Section>

        {/* 4. Границы */}
        <Section n={4} title="Стоп-темы" hint="О чём не писать никогда. Автопилот будет обходить это стороной.">
          <Textarea
            rows={3}
            value={brief.taboo}
            onChange={(e) => set("taboo", e.target.value)}
            placeholder="Например: политика, чужие бренды, обещания «заработка на кофе»"
          />
        </Section>

        {/* Сохранение */}
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-[13px] text-text-3">
            {complete
              ? "Готово — автопилот будет писать по этому брифу."
              : "Заполни «о чём канал» и «для кого» — без них автопилот не запустится."}
          </p>
          <Button variant="brand" onClick={save} loading={saving} disabled={saving || !complete}>
            {saving ? (
              <Loader2 className="h-[18px] w-[18px] animate-spin" aria-hidden />
            ) : (
              <Check className="h-[18px] w-[18px]" strokeWidth={2.5} aria-hidden />
            )}
            Сохранить настройку
          </Button>
        </Card>
      </div>
    </AppShell>
  );
}

function Section({
  n,
  title,
  hint,
  required,
  children,
}: {
  n: number;
  title: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-4 flex items-baseline gap-2.5">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-info-soft text-[12px] font-bold text-brand">
          {n}
        </span>
        <div className="min-w-0">
          <h2 className="text-[15px] font-bold text-text">
            {title}
            {required && <span className="ml-1 text-danger">*</span>}
          </h2>
          {hint && <p className="mt-0.5 text-[13px] leading-relaxed text-text-3">{hint}</p>}
        </div>
      </div>
      <div className="space-y-4">{children}</div>
    </Card>
  );
}

// useSearchParams заставляет клиентское дерево до ближайшего Suspense рендериться на клиенте
// (доки Next 16, use-search-params). Без границы это утянуло бы за собой всю страницу.
export default function BriefPage() {
  return (
    <Suspense fallback={<div className="skeleton h-64 rounded-lg" />}>
      <BriefInner />
    </Suspense>
  );
}
