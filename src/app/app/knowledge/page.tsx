"use client";

// База знаний канала (РАГ). ОТКУДА автопилот берёт факты для постов.
//
// Зачем этот экран вообще существует: ИИ выдумывал. В канал ушло «решение Судьи
// Московского округа от 10 июля 2026 года» — такого решения нет. Взять правду ему было
// негде: в задание уходили только бриф и пара своих постов, ни одного факта. Здесь человек
// кладёт факты — и посты перестают быть выдумкой.
//
// Замерено на живой базе: как только под тему находится опора, hermes3 держится за неё и
// не сочиняет ни дат, ни сумм, ни номеров дел. Нет опоры — пишем общо, но честно, а не врём.

import { useCallback, useEffect, useState } from "react";
import { BookText, FileText, Loader2, Radio, Trash2, User } from "lucide-react";
import { AppShell } from "@/components/app/shell";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Field, Input, Tabs, Textarea } from "@/components/ui/primitives";
import { ChannelPicker, useChannelChoice } from "@/components/app/channel-picker";
import { useStore } from "@/lib/store";
import { fmtAgo, plural } from "@/lib/utils";

interface Source {
  id: number;
  kind: string;
  title: string;
  status: "pending" | "ready" | "error";
  last_error: string | null;
  added_at: string;
  indexed_at: string | null;
  chunks: number;
}
interface State {
  sources: Source[];
  facts: number;
  voice: number;
  channelId: number | null;
}

type Mode = "paste" | "form" | "channel";

// Три способа наполнить базу. Не «загрузи файл» (загрузки файлов пока нет) — а ровно то,
// что у юриста уже под рукой: текст можно вставить, про себя ответить на вопросы, канал
// прочитать одной кнопкой.
const MODES: { value: Mode; label: string; icon: React.ReactNode }[] = [
  { value: "paste", label: "Вставить текст", icon: <FileText className="h-4 w-4" aria-hidden /> },
  { value: "form", label: "О себе и услугах", icon: <User className="h-4 w-4" aria-hidden /> },
  { value: "channel", label: "Прочитать канал", icon: <Radio className="h-4 w-4" aria-hidden /> },
];

const KIND_LABEL: Record<string, string> = {
  paste: "Текст",
  form: "О себе",
  channel: "Канал",
  file: "Файл",
};

export default function KnowledgePage() {
  const store = useStore();
  const [picked, setPicked] = useState<number | null>(null);
  const { tgChannels, channelId } = useChannelChoice(store.realChannels, picked);

  const [data, setData] = useState<State | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<Mode>("paste");

  const load = useCallback(async () => {
    if (!channelId) {
      setData(null);
      setLoading(false);
      return;
    }
    try {
      const r = await fetch(`/api/knowledge?channel=${channelId}`, { cache: "no-store" });
      setData((await r.json()) as State);
    } catch {
      /* сеть */
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- загрузка при монтировании/смене канала
    load();
  }, [load]);

  // Пока хоть один источник считается — опрашиваем: «готово» должно появиться само.
  const indexing = data?.sources.some((s) => s.status === "pending") ?? false;
  useEffect(() => {
    if (!indexing) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [indexing, load]);

  if (loading) {
    return (
      <AppShell title="База знаний">
        <div className="space-y-4">
          <div className="skeleton h-24 rounded-lg" />
          <div className="skeleton h-64 rounded-lg" />
        </div>
      </AppShell>
    );
  }

  if (!tgChannels.length) {
    return (
      <AppShell title="База знаний" subtitle="Факты, из которых автопилот пишет посты.">
        <Card className="py-4">
          <EmptyState
            icon={<BookText className="h-6 w-6" strokeWidth={1.75} aria-hidden />}
            title="Сначала подключи канал"
            body="База знаний живёт на канале — у каждого своя. Подключи канал, и сможешь наполнить её фактами."
          />
        </Card>
      </AppShell>
    );
  }

  const facts = data?.facts ?? 0;

  return (
    <AppShell
      title="База знаний"
      subtitle="Факты, из которых автопилот пишет посты. Есть опора — пишет по ней; нет — не выдумывает."
    >
      <ChannelPicker
        channels={tgChannels}
        value={channelId}
        onChange={setPicked}
        label="База какого канала"
        className="mb-5"
      />

      {/* Честный счётчик: считаем ОПОРУ (факты), а не всё подряд. Голос — образец стиля,
          фактом он быть не может, поэтому в этом числе его нет. */}
      <Card className="mb-5 flex flex-wrap items-center justify-between gap-4 p-4">
        <div className="flex items-baseline gap-2.5">
          <span className="text-[28px] font-bold text-text">{facts}</span>
          <span className="text-[14px] text-text-2">
            {plural(facts, "факт", "факта", "фактов")} в опоре
          </span>
          {data?.voice ? (
            <span className="text-[13px] text-text-3">· и {data.voice} для стиля</span>
          ) : null}
        </div>
        {facts === 0 ? (
          <p className="max-w-[46ch] text-[13px] text-text-3">
            Пока опоры нет — автопилот пишет общо, без дат и сумм. Добавь материалы, и посты
            станут предметными.
          </p>
        ) : (
          <Badge tone="success">автопилот пишет по фактам</Badge>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <AddPanel channelId={channelId!} mode={mode} onMode={setMode} onDone={load} store={store} />
        <SourceList sources={data?.sources ?? []} onDelete={load} store={store} />
      </div>
    </AppShell>
  );
}

/* ------------------------------------------------------------- ДОБАВИТЬ */

function AddPanel({
  channelId,
  mode,
  onMode,
  onDone,
  store,
}: {
  channelId: number;
  mode: Mode;
  onMode: (m: Mode) => void;
  onDone: () => void;
  store: ReturnType<typeof useStore>;
}) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  // Форма «о себе» — не свободный текст, а вопросы: человек не знает, что писать в пустое
  // поле, а на конкретный вопрос отвечает. Ответы склеиваем в один источник.
  const [form, setForm] = useState({ about: "", services: "", prices: "", taboo: "" });

  const reset = () => {
    setTitle("");
    setText("");
    setForm({ about: "", services: "", prices: "", taboo: "" });
  };

  const submit = async () => {
    if (busy) return;
    let payload: { kind: Mode; title: string; text: string };

    if (mode === "form") {
      const parts = [
        form.about && `Кто я и о чём канал: ${form.about}`,
        form.services && `Услуги: ${form.services}`,
        form.prices && `Цены и сроки: ${form.prices}`,
        form.taboo && `Чего я НЕ обещаю и о чём не пишу: ${form.taboo}`,
      ].filter(Boolean);
      if (!parts.length) {
        store.toast({ kind: "info", title: "Заполни хотя бы одно поле" });
        return;
      }
      payload = { kind: "form", title: "О себе и услугах", text: parts.join("\n\n") };
    } else if (mode === "channel") {
      // Чтение канала — отдельный маршрут (тот же скрейпер, что у брифа): ходит наружу.
      setBusy(true);
      try {
        const r = await fetch("/api/knowledge/read-channel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channelId }),
        });
        const d = (await r.json().catch(() => null)) as
          | { ok?: boolean; error?: string; posts?: number }
          | null;
        if (d?.ok) {
          store.toast({
            kind: "success",
            title: `Прочитал ${d.posts ?? 0} ${plural(d.posts ?? 0, "пост", "поста", "постов")}`,
            body: "Это образец твоего стиля. Факты для постов всё равно нужны отдельно.",
          });
          onDone();
        } else {
          store.toast({
            kind: "danger",
            title: "Не вышло прочитать канал",
            body:
              d?.error === "no_posts"
                ? "На открытой странице канала пока нет постов."
                : "Проверь, что канал публичный, и попробуй ещё раз.",
          });
        }
      } finally {
        setBusy(false);
      }
      return;
    } else {
      const t = text.trim();
      if (!t) {
        store.toast({ kind: "info", title: "Вставь текст" });
        return;
      }
      payload = { kind: "paste", title: title.trim() || "Без названия", text: t };
    }

    setBusy(true);
    try {
      const r = await fetch("/api/knowledge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId, ...payload }),
      });
      const d = (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (d?.ok) {
        store.toast({ kind: "success", title: "Добавил — считаю факты", body: "Готово будет через несколько секунд." });
        reset();
        onDone();
      } else {
        const why: Record<string, string> = {
          too_long: "Текст слишком длинный. Разбей на части поменьше.",
          empty: "Текст пустой.",
        };
        store.toast({ kind: "danger", title: "Не вышло", body: why[d?.error ?? ""] ?? "Попробуй ещё раз." });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-4 p-5">
      <Tabs value={mode} onChange={onMode} items={MODES} />

      {mode === "paste" && (
        <div className="space-y-4">
          <Field label="Название" hint="Чтобы потом найти в списке — например «ФЗ-127: сроки».">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Закон и процедура" />
          </Field>
          <Field
            label="Текст"
            hint="Законы, разборы, реальные кейсы, частые вопросы клиентов с ответами. Разделяй факты пустой строкой — каждый станет отдельной опорой."
          >
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={9}
              placeholder={"Процедура реализации имущества вводится на шесть месяцев…\n\nЕдинственное жильё не включается в конкурсную массу — статья 446 ГПК РФ…"}
            />
          </Field>
        </div>
      )}

      {mode === "form" && (
        <div className="space-y-4">
          <Field label="Кто ты и о чём канал">
            <Textarea
              value={form.about}
              onChange={(e) => setForm((f) => ({ ...f, about: e.target.value }))}
              rows={2}
              placeholder="Юрист по банкротству физлиц, 8 лет практики, веду дела по всей России."
            />
          </Field>
          <Field label="Услуги — что именно делаешь">
            <Textarea
              value={form.services}
              onChange={(e) => setForm((f) => ({ ...f, services: e.target.value }))}
              rows={2}
              placeholder="Банкротство под ключ, сопровождение в суде, защита единственного жилья."
            />
          </Field>
          <Field label="Цены и сроки">
            <Textarea
              value={form.prices}
              onChange={(e) => setForm((f) => ({ ...f, prices: e.target.value }))}
              rows={2}
              placeholder="Банкротство под ключ — 120 000 ₽, рассрочка 10 месяцев. Срок — 6–9 месяцев."
            />
          </Field>
          <Field label="Чего НЕ обещаешь" hint="Важно: удержит ИИ от обещаний, за которые тебе потом отвечать.">
            <Textarea
              value={form.taboo}
              onChange={(e) => setForm((f) => ({ ...f, taboo: e.target.value }))}
              rows={2}
              placeholder="Не гарантирую стопроцентное списание — оно зависит от ситуации."
            />
          </Field>
        </div>
      )}

      {mode === "channel" && (
        <div className="rounded-sm bg-surface-inset p-4 text-[14px] text-text-2">
          <p>
            Прочитаю открытую страницу твоего канала и сохраню посты как образец стиля — чтобы
            автопилот писал твоим голосом.
          </p>
          <p className="mt-2 text-[13px] text-text-3">
            Это стиль, а не факты. Факты (законы, кейсы, цены) всё равно добавь отдельно —
            только на них автопилот опирается, когда пишет конкретику.
          </p>
        </div>
      )}

      <Button variant="brand" onClick={submit} loading={busy} disabled={busy} className="w-full">
        {mode === "channel" ? "Прочитать канал" : "Добавить в базу"}
      </Button>
    </Card>
  );
}

/* --------------------------------------------------------------- СПИСОК */

function SourceList({
  sources,
  onDelete,
  store,
}: {
  sources: Source[];
  onDelete: () => void;
  store: ReturnType<typeof useStore>;
}) {
  const del = async (id: number, title: string) => {
    await fetch(`/api/knowledge?id=${id}`, { method: "DELETE" }).catch(() => {});
    store.toast({ kind: "info", title: `Убрал «${title}»` });
    onDelete();
  };

  if (!sources.length) {
    return (
      <Card className="grid place-items-center p-8 text-center">
        <EmptyState
          icon={<BookText className="h-6 w-6" strokeWidth={1.75} aria-hidden />}
          title="База пока пустая"
          body="Добавь первый материал слева. Начни с малого: услуги и цены, 3–5 реальных кейсов, частые вопросы клиентов — этого уже хватит, чтобы посты стали про тебя."
        />
      </Card>
    );
  }

  return (
    <Card className="divide-y divide-line p-0">
      {sources.map((s) => (
        <div key={s.id} className="flex items-start gap-3 p-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[14px] font-semibold text-text">{s.title}</span>
              <Badge tone="neutral">{KIND_LABEL[s.kind] ?? s.kind}</Badge>
            </div>
            <p className="mt-1 text-[13px] text-text-3">
              {s.status === "pending" ? (
                <span className="inline-flex items-center gap-1.5 text-text-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  {s.last_error || "считаю факты…"}
                </span>
              ) : s.status === "error" ? (
                <span className="text-danger-text">{s.last_error || "не вышло разобрать"}</span>
              ) : (
                <>
                  {s.kind === "channel" ? (
                    <>{s.chunks} {plural(s.chunks, "пост-образец", "поста-образца", "постов-образцов")} стиля</>
                  ) : (
                    <>{s.chunks} {plural(s.chunks, "факт", "факта", "фактов")} · опора для постов</>
                  )}
                  {" · "}
                  {fmtAgo(s.added_at)}
                </>
              )}
            </p>
          </div>
          <button
            onClick={() => del(s.id, s.title)}
            className="shrink-0 rounded-xs p-2 text-text-3 transition-colors hover:bg-danger-soft hover:text-danger-text"
            aria-label={`Убрать «${s.title}»`}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ))}
    </Card>
  );
}
