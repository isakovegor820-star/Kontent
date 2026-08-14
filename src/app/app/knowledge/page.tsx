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

import { useCallback, useEffect, useRef, useState } from "react";
import { BookText, FileText, Loader2, Radio, Trash2, TriangleAlert, User } from "lucide-react";
import { AppShell } from "@/components/app/shell";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Field, Input, Tabs, Textarea } from "@/components/ui/primitives";
import { ChannelPicker, useChannelChoice } from "@/components/app/channel-picker";
import { useStore } from "@/lib/store";
import { fmtAgo, plural } from "@/lib/utils";
import type { EffectiveProfile, ProfileField, ProfileSourceKind } from "@/lib/effective-ai-context";

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
  ok: true;
  sources: Source[];
  facts: number;
  voice: number;
  channelId: number | null;
  effectiveProfile: EffectiveProfile;
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

const PROFILE_FIELD_LABEL: Record<ProfileField, string> = {
  niche: "Ниша",
  topics: "Темы",
  services: "Услуги и продукты",
  prices: "Цены и сроки",
  audience: "Аудитория",
  tone: "Тон",
  taboos: "Табу",
  goal: "Цель",
};

const PROFILE_SOURCE_LABEL: Record<ProfileSourceKind, string> = {
  verified_brief: "Подтверждённый бриф",
  profile_edit: "Подтверждено вручную",
  profile: "Авто-профиль",
  settings: "Настройки",
};

export default function KnowledgePage() {
  const store = useStore();
  const [picked, setPicked] = useState<number | null>(null);
  const { tgChannels, channelId } = useChannelChoice(store.realChannels, picked);

  const [data, setData] = useState<State | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [mode, setMode] = useState<Mode>("paste");
  const loadSeq = useRef(0);

  const load = useCallback(async (showLoading = false) => {
    const seq = ++loadSeq.current;
    if (showLoading) {
      setLoading(true);
      setData(null);
    }
    if (!channelId) {
      setData(null);
      setLoadError(false);
      setLoading(false);
      return;
    }
    try {
      const r = await fetch(`/api/knowledge?channel=${channelId}`, { cache: "no-store" });
      const next = (await r.json().catch(() => null)) as State | null;
      if (!r.ok || !next?.ok || next.channelId !== channelId) throw new Error("knowledge_unavailable");
      if (seq !== loadSeq.current) return;
      setData(next);
      setLoadError(false);
    } catch {
      if (seq === loadSeq.current) setLoadError(true);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- загрузка при монтировании/смене канала
    void load(true);
    return () => {
      loadSeq.current += 1;
    };
  }, [load]);

  // Пока хоть один источник считается — опрашиваем: «готово» должно появиться само.
  const indexing = data?.sources.some((s) => s.status === "pending") ?? false;
  useEffect(() => {
    if (!indexing) return;
    const t = setInterval(() => void load(false), 3000);
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

  if (store.realError && !tgChannels.length) {
    return (
      <AppShell title="База знаний" subtitle="Факты, профиль и источники выбранного канала.">
        <Card className="p-6" role="alert">
          <TriangleAlert className="h-6 w-6 text-danger-text" aria-hidden />
          <h2 className="mt-3 text-[18px] font-extrabold text-text">Каналы не загрузились</h2>
          <p className="mt-2 text-[14px] leading-relaxed text-text-2">
            Не выдаём ошибку сервера за отсутствие каналов. Сохранённые данные не менялись.
          </p>
          <Button className="mt-4" variant="outline" onClick={() => void store.refreshReal()}>
            Повторить
          </Button>
        </Card>
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

  if (loadError && !data) {
    return (
      <AppShell title="База знаний" subtitle="Факты, профиль и источники выбранного канала.">
        <Card className="p-6" role="alert">
          <TriangleAlert className="h-6 w-6 text-danger-text" aria-hidden />
          <h2 className="mt-3 text-[18px] font-extrabold text-text">Не удалось загрузить базу</h2>
          <p className="mt-2 text-[14px] leading-relaxed text-text-2">
            Не показываем пустую базу вместо ошибки. Данные на сервере не менялись.
          </p>
          <Button className="mt-4" variant="outline" onClick={() => void load(true)}>
            Повторить
          </Button>
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

      {loadError && data && (
        <p role="alert" className="mb-5 rounded-sm bg-danger-soft p-3 text-[13px] text-danger-text">
          Последнее обновление не удалось. Ниже оставлены ранее подтверждённые данные этого канала.
        </p>
      )}

      <Card className="mb-5 p-4 sm:p-5" as="section">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-[16px] font-extrabold text-text">Эффективный профиль ИИ</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-text-3">
              Именно эти значения попадут в следующую генерацию. Источник показан у каждого поля.
            </p>
          </div>
          <Badge tone="neutral">канал #{channelId}</Badge>
        </div>
        {Object.entries(data?.effectiveProfile ?? {}).length > 0 ? (
          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            {Object.entries(data?.effectiveProfile ?? {}).map(([field, selected]) =>
              selected ? (
                <div key={field} className="rounded-sm border border-line bg-surface-2 p-3">
                  <dt className="text-[12px] font-bold text-text-3">
                    {PROFILE_FIELD_LABEL[field as ProfileField]}
                  </dt>
                  <dd className="mt-1 text-[14px] leading-relaxed text-text">{selected.value}</dd>
                  <dd className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-text-3">
                    <Badge tone={selected.verified ? "success" : "neutral"}>
                      {PROFILE_SOURCE_LABEL[selected.sourceKind]}
                    </Badge>
                    {selected.verified ? "подтверждено" : "нужно проверить"}
                  </dd>
                </div>
              ) : null,
            )}
          </dl>
        ) : (
          <p className="mt-4 rounded-sm bg-fire-soft p-3 text-[13px] text-fire-text">
            Профиль пока не собран. ИИ не будет подставлять выдуманную нишу или тон.
          </p>
        )}
      </Card>

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
              onChange={(event) => {
                const value = event.currentTarget.value;
                setForm((current) => ({ ...current, about: value }));
              }}
              rows={2}
              placeholder="Юрист по банкротству физлиц, 8 лет практики, веду дела по всей России."
            />
          </Field>
          <Field label="Услуги — что именно делаешь">
            <Textarea
              value={form.services}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setForm((current) => ({ ...current, services: value }));
              }}
              rows={2}
              placeholder="Банкротство под ключ, сопровождение в суде, защита единственного жилья."
            />
          </Field>
          <Field label="Цены и сроки">
            <Textarea
              value={form.prices}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setForm((current) => ({ ...current, prices: value }));
              }}
              rows={2}
              placeholder="Банкротство под ключ — 120 000 ₽, рассрочка 10 месяцев. Срок — 6–9 месяцев."
            />
          </Field>
          <Field label="Чего НЕ обещаешь" hint="Важно: удержит ИИ от обещаний, за которые тебе потом отвечать.">
            <Textarea
              value={form.taboo}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setForm((current) => ({ ...current, taboo: value }));
              }}
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
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const del = async (id: number, title: string) => {
    if (deletingId != null) return;
    setDeletingId(id);
    try {
      const response = await fetch(`/api/knowledge?id=${id}`, { method: "DELETE" });
      const body = (await response.json().catch(() => null)) as { ok?: boolean } | null;
      if (!response.ok || !body?.ok) throw new Error("delete_not_confirmed");
      store.toast({ kind: "info", title: `Убрал «${title}»` });
      onDelete();
    } catch {
      store.toast({
        kind: "danger",
        title: "Источник не удалён",
        body: "Сервер не подтвердил изменение. Он остаётся в базе.",
      });
    } finally {
      setDeletingId(null);
    }
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
          <Button
            type="button"
            variant="danger"
            size="icon"
            disabled={deletingId != null}
            onClick={() => void del(s.id, s.title)}
            className="shrink-0"
            aria-label={`Убрать «${s.title}»`}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      ))}
    </Card>
  );
}
