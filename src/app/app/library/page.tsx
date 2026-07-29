"use client";

// Библиотека: три раздела.
// 1. «Хиты ниши» — залетевшие посты конкурентов (собирает разведка): на что ориентироваться.
// 2. «Мои посты» — сохранённые тексты для повторного использования.
// 3. «Хэштеги» — именованные наборы тегов, вставляются одним нажатием.

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Bookmark,
  Copy,
  ExternalLink,
  Eye,
  Flame,
  Hash,
  Heart,
  Link2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Input } from "@/components/ui/primitives";
import { useStore } from "@/lib/store";
import { cn, fmtAgo, fmtNum } from "@/lib/utils";

/* ------------------------------------------------------------------ ТИПЫ */

type SavedPost = { id: number; text: string; note: string | null; tags: string[]; created_at: string };
type HashtagSet = { id: number; name: string; tags: string[]; created_at: string };
type Hit = {
  id: number;
  text: string;
  views: number | null;
  reactions: number | null;
  hit_ratio: string | number | null;
  posted_at: string;
  media: string | null;
  tg_msg_id: number | null;
  source_title: string | null;
  handle: string | null;
};
type Tab = "hits" | "posts" | "tags";

const TABS: { key: Tab; label: string; icon: typeof Flame }[] = [
  { key: "hits", label: "Хиты ниши", icon: Flame },
  { key: "posts", label: "Мои посты", icon: Bookmark },
  { key: "tags", label: "Хэштеги", icon: Hash },
];

// Карточки страницы поднимаются при наведении — единый жест рабочих экранов.
const HOVER =
  "transition-[box-shadow,border-color] duration-200 hover:border-line-strong hover:shadow-soft";

/* ----------------------------------------------------------------- ЭКРАН */

function LibraryInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const s = useStore();

  const tabParam = searchParams.get("tab");
  const [tab, setTab] = useState<Tab>(
    tabParam === "posts" || tabParam === "tags" ? tabParam : "hits",
  );

  // Хиты ниши
  const [hits, setHits] = useState<Hit[]>([]);
  const [hitsLoading, setHitsLoading] = useState(true);
  const [hitsError, setHitsError] = useState<"no_channel" | "server" | null>(null);

  // Мои посты и наборы
  const [posts, setPosts] = useState<SavedPost[]>([]);
  const [sets, setSets] = useState<HashtagSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [q, setQ] = useState("");

  // Форма нового поста
  const [newText, setNewText] = useState("");
  const [newTags, setNewTags] = useState("");
  const [saving, setSaving] = useState(false);

  // Форма нового набора тегов
  const [setName, setSetName] = useState("");
  const [setTags, setSetTags] = useState("");
  const [savingSet, setSavingSet] = useState(false);

  const loadHits = useCallback(async () => {
    try {
      const r = await fetch("/api/library/hits", { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        setHits(d.hits ?? []);
        setHitsError(null);
      } else if (r.status === 422) {
        setHitsError("no_channel");
      } else {
        setHitsError("server");
      }
    } catch {
      setHitsError("server");
    }
  }, []);

  const loadPosts = useCallback(async (query?: string) => {
    try {
      const url = query ? `/api/library/posts?q=${encodeURIComponent(query)}` : "/api/library/posts";
      const r = await fetch(url, { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        setPosts(d.posts ?? []);
        setLoadError(false);
      } else {
        setLoadError(true);
      }
    } catch { setLoadError(true); }
  }, []);

  const loadSets = useCallback(async () => {
    try {
      const r = await fetch("/api/library/tags", { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        setSets(d.sets ?? []);
        setLoadError(false);
      } else {
        setLoadError(true);
      }
    } catch { setLoadError(true); }
  }, []);

  const reload = useCallback(() => {
    setLoadError(false);
    setLoading(true);
    setHitsLoading(true);
    Promise.all([loadHits(), loadPosts(), loadSets()]).finally(() => {
      setLoading(false);
      setHitsLoading(false);
    });
  }, [loadHits, loadPosts, loadSets]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload();
  }, [reload]);

  // Поиск по своим постам (debounce)
  useEffect(() => {
    if (tab !== "posts") return;
    const t = setTimeout(() => loadPosts(q.trim() || undefined), 300);
    return () => clearTimeout(t);
  }, [q, tab, loadPosts]);

  const savePost = async () => {
    const text = newText.trim();
    if (!text) return;
    setSaving(true);
    try {
      const tags = newTags.split(",").map((t) => t.trim()).filter(Boolean);
      const r = await fetch("/api/library/posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, tags }),
      });
      if (r.ok) {
        setNewText("");
        setNewTags("");
        await loadPosts();
        s.toast({ kind: "success", title: "Сохранено в библиотеку" });
      }
    } catch { /* ignore */ }
    setSaving(false);
  };

  const deletePost = async (id: number) => {
    await fetch(`/api/library/posts?id=${id}`, { method: "DELETE" });
    setPosts((prev) => prev.filter((p) => p.id !== id));
  };

  const saveSet = async () => {
    const name = setName.trim();
    const tags = setTags.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
    if (!name || !tags.length) return;
    setSavingSet(true);
    try {
      const r = await fetch("/api/library/tags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, tags }),
      });
      if (r.ok) {
        setSetName("");
        setSetTags("");
        await loadSets();
        s.toast({ kind: "success", title: `Набор «${name}» сохранён` });
      }
    } catch { /* ignore */ }
    setSavingSet(false);
  };

  const deleteSet = async (id: number) => {
    await fetch(`/api/library/tags?id=${id}`, { method: "DELETE" });
    setSets((prev) => prev.filter((x) => x.id !== id));
  };

  const openInComposer = (text: string) => {
    // Кодируем текст и переходим в композер
    router.push(`/app/composer?lib=${encodeURIComponent(text.slice(0, 4000))}`);
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      s.toast({ kind: "info", title: "Скопировано" });
    } catch { /* ignore */ }
  };

  const hitRatio = (h: Hit) => {
    const n = Number(h.hit_ratio);
    return Number.isFinite(n) && n > 0 ? n.toFixed(1) : null;
  };

  return (
    <div className="mx-auto w-full">
      {/* Ошибка загрузки своих данных */}
      {loadError && (
        <Card className="mt-5 p-4">
          <div className="flex items-center justify-between">
            <p className="text-[14px] text-text">Не удалось загрузить данные</p>
            <Button variant="soft" size="sm" onClick={reload}>
              <RefreshCw className="h-4 w-4" />
              Повторить
            </Button>
          </div>
        </Card>
      )}

      {/* Табы */}
      <div className="mt-5 inline-flex rounded-sm border border-line bg-surface p-1">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                "flex items-center gap-1.5 rounded-[3px] px-4 py-1.5 text-[13px] font-semibold transition-colors",
                tab === t.key ? "bg-info-soft text-info-text" : "text-text-3 hover:text-text",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* ============================ ХИТЫ НИШИ ============================ */}
      {tab === "hits" && (
        <div className="mt-5">
          {hitsLoading ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-40" />)}
            </div>
          ) : hitsError === "no_channel" ? (
            <Card>
              <EmptyState
                icon={<Link2 className="h-6 w-6" />}
                title="Сначала подключи канал"
                body="Хиты ниши собираются по твоему каналу: разведка следит за конкурентами и находит посты, которые залетели сильнее их нормы."
                action={
                  <Link href="/app/settings">
                    <Button variant="solid" size="sm">
                      <Link2 className="h-4 w-4" />
                      Подключить канал
                    </Button>
                  </Link>
                }
              />
            </Card>
          ) : hitsError ? (
            <Card className="p-4">
              <div className="flex items-center justify-between">
                <p className="text-[14px] text-text">Не удалось загрузить хиты</p>
                <Button
                  variant="soft"
                  size="sm"
                  onClick={() => { setHitsError(null); setHitsLoading(true); loadHits().finally(() => setHitsLoading(false)); }}
                >
                  <RefreshCw className="h-4 w-4" />
                  Повторить
                </Button>
              </div>
            </Card>
          ) : hits.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Flame className="h-6 w-6" />}
                title="Пока не на чём учиться"
                body="Добавь конкурентов в разведке — и я найду их посты, которые залетели сильнее обычного. Сюда они придут с цифрами: смотри, что работает, и снимай своё."
                action={
                  <Link href="/app/competitors">
                    <Button variant="solid" size="sm">
                      <Plus className="h-4 w-4" />
                      Добавить конкурентов
                    </Button>
                  </Link>
                }
              />
            </Card>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {hits.map((h) => {
                const ratio = hitRatio(h);
                const originalUrl = h.handle && h.tg_msg_id ? `https://t.me/${h.handle}/${h.tg_msg_id}` : null;
                return (
                  <Card key={h.id} className={cn("flex flex-col p-4", HOVER)}>
                    <div className="flex items-center gap-2 text-[12px]">
                      <p className="min-w-0 truncate font-semibold text-text">
                        {h.source_title || (h.handle ? `@${h.handle}` : "Конкурент")}
                      </p>
                      <span className="shrink-0 text-text-3">{fmtAgo(h.posted_at)}</span>
                      {originalUrl && (
                        <a
                          href={originalUrl}
                          target="_blank"
                          rel="noreferrer"
                          title="Открыть оригинал"
                          className="ml-auto shrink-0 rounded-xs p-1 text-text-3 transition-colors hover:bg-surface-inset hover:text-text"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      )}
                    </div>
                    <p className="mt-2 line-clamp-4 flex-1 text-[14px] leading-relaxed whitespace-pre-wrap text-text">
                      {h.text}
                    </p>
                    <div className="mt-3 flex items-center gap-3 text-[12px] text-text-3">
                      {h.views != null && (
                        <span className="flex items-center gap-1">
                          <Eye className="h-3.5 w-3.5" />
                          {fmtNum(h.views)}
                        </span>
                      )}
                      {h.reactions != null && h.reactions > 0 && (
                        <span className="flex items-center gap-1">
                          <Heart className="h-3.5 w-3.5" />
                          {fmtNum(h.reactions)}
                        </span>
                      )}
                      {ratio && <Badge tone="fire">×{ratio} выше нормы</Badge>}
                      {h.media && h.media.includes("video") && <Badge tone="neutral">видео</Badge>}
                    </div>
                    <div className="mt-3 flex items-center gap-1.5 border-t border-line pt-3">
                      <Button variant="soft" size="sm" onClick={() => openInComposer(h.text)}>
                        В композер
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => copyText(h.text)} title="Скопировать">
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ============================ МОИ ПОСТЫ ============================ */}
      {tab === "posts" && (
        <div className="mt-5 space-y-4">
          {/* Поиск */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Поиск по тексту или тегам…"
              className="pl-9"
            />
          </div>

          {/* Форма добавления */}
          <Card className="p-4">
            <textarea
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              placeholder="Вставь текст поста для сохранения…"
              rows={3}
              className="w-full resize-y rounded-sm border border-line bg-surface-inset px-3 py-2 text-[14px] text-text placeholder:text-text-3 focus:border-brand focus:outline-none"
            />
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                value={newTags}
                onChange={(e) => setNewTags(e.target.value)}
                placeholder="Теги через запятую (необязательно)"
                className="flex-1"
              />
              <Button variant="solid" size="sm" onClick={savePost} loading={saving} disabled={!newText.trim()}>
                <Plus className="h-4 w-4" />
                Сохранить
              </Button>
            </div>
          </Card>

          {/* Список */}
          {loading ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {[0, 1].map((i) => <div key={i} className="skeleton h-24" />)}
            </div>
          ) : posts.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Bookmark className="h-5 w-5" />}
                title="Пока пусто"
                body="Сохрани удачный пост — он будет здесь для повторного использования."
              />
            </Card>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {posts.map((p) => (
                <Card key={p.id} className={cn("flex flex-col p-4", HOVER)}>
                  <p className="line-clamp-4 flex-1 text-[14px] leading-relaxed whitespace-pre-wrap text-text">
                    {p.text}
                  </p>
                  {p.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {p.tags.map((t) => (
                        <Badge key={t} tone="neutral">{t}</Badge>
                      ))}
                    </div>
                  )}
                  <div className="mt-3 flex items-center gap-1.5 border-t border-line pt-3">
                    <Button variant="soft" size="sm" onClick={() => openInComposer(p.text)}>
                      В композер
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => copyText(p.text)} title="Скопировать">
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    <span className="ml-auto text-[12px] text-text-3">{fmtAgo(p.created_at)}</span>
                    <Button variant="ghost" size="sm" onClick={() => deletePost(p.id)} className="text-danger-text" title="Удалить">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ============================= ХЭШТЕГИ ============================= */}
      {tab === "tags" && (
        <div className="mt-5 space-y-4">
          {/* Форма нового набора */}
          <Card className="p-4">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={setName}
                onChange={(e) => setSetName(e.target.value)}
                placeholder="Название набора"
                className="sm:w-48"
              />
              <Input
                value={setTags}
                onChange={(e) => setSetTags(e.target.value)}
                placeholder="#теги через пробел или запятую"
                className="flex-1"
              />
              <Button variant="solid" size="sm" onClick={saveSet} loading={savingSet} disabled={!setName.trim() || !setTags.trim()}>
                <Plus className="h-4 w-4" />
                Создать
              </Button>
            </div>
          </Card>

          {/* Список наборов */}
          {loading ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {[0, 1].map((i) => <div key={i} className="skeleton h-20" />)}
            </div>
          ) : sets.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Hash className="h-5 w-5" />}
                title="Наборов пока нет"
                body="Создай набор хэштегов — вставляй в пост одним нажатием."
              />
            </Card>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {sets.map((st) => (
                <Card key={st.id} className={cn("p-4", HOVER)}>
                  <div className="flex items-center gap-2">
                    <p className="text-[15px] font-bold text-text">{st.name}</p>
                    <Button variant="ghost" size="sm" onClick={() => deleteSet(st.id)} className="ml-auto text-danger-text" title="Удалить">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {st.tags.map((t) => (
                      <Badge key={t} tone="neutral">{t}</Badge>
                    ))}
                  </div>
                  <div className="mt-2">
                    <Button variant="ghost" size="sm" onClick={() => copyText(st.tags.join(" "))}>
                      <Copy className="h-3.5 w-3.5" />
                      Скопировать все
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function LibraryPage() {
  return (
    <AppShell title="Библиотека" subtitle="Залетевшие посты ниши для ориентира + твои заготовки.">
      <Suspense fallback={<div className="skeleton h-64" />}>
        <LibraryInner />
      </Suspense>
    </AppShell>
  );
}
