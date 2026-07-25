"use client";

// Библиотека: сохранённые посты + наборы хэштегов.
// Юзер сохраняет удачные тексты и теги, потом вставляет повторно в композер.

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Bookmark, Copy, Hash, Plus, RefreshCw, Search, Trash2 } from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Input } from "@/components/ui/primitives";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ ТИПЫ */

type SavedPost = { id: number; text: string; note: string | null; tags: string[]; created_at: string };
type HashtagSet = { id: number; name: string; tags: string[]; created_at: string };

/* ----------------------------------------------------------------- ЭКРАН */

function LibraryInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const s = useStore();

  const [tab, setTab] = useState<"posts" | "tags">(
    searchParams.get("tab") === "tags" ? "tags" : "posts",
  );
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
    Promise.all([loadPosts(), loadSets()]).finally(() => setLoading(false));
  }, [loadPosts, loadSets]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload();
  }, [reload]);

  // Поиск (debounce)
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

  return (
    <div className="mx-auto w-full max-w-3xl">
      {/* Ошибка загрузки */}
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
        {(["posts", "tags"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "flex items-center gap-1.5 rounded-[3px] px-4 py-1.5 text-[13px] font-semibold transition-colors",
              tab === t ? "bg-info-soft text-info-text" : "text-text-3 hover:text-text",
            )}
          >
            {t === "posts" ? <Bookmark className="h-3.5 w-3.5" /> : <Hash className="h-3.5 w-3.5" />}
            {t === "posts" ? "Посты" : "Хэштеги"}
          </button>
        ))}
      </div>

      {tab === "posts" ? (
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
            <div className="space-y-2">
              {[0, 1, 2].map((i) => <div key={i} className="skeleton h-24" />)}
            </div>
          ) : posts.length === 0 ? (
            <EmptyState
              icon={<Bookmark className="h-5 w-5" />}
              title="Пока пусто"
              body="Сохрани удачный пост — он будет здесь для повторного использования."
            />
          ) : (
            <div className="space-y-3">
              {posts.map((p) => (
                <Card key={p.id} className="p-4">
                  <p className="line-clamp-4 text-[14px] leading-relaxed whitespace-pre-wrap text-text">
                    {p.text}
                  </p>
                  {p.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {p.tags.map((t) => (
                        <Badge key={t} tone="neutral">{t}</Badge>
                      ))}
                    </div>
                  )}
                  <div className="mt-3 flex items-center gap-1.5">
                    <Button variant="soft" size="sm" onClick={() => openInComposer(p.text)}>
                      В композер
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => copyText(p.text)}>
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => deletePost(p.id)} className="ml-auto text-danger-text">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      ) : (
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
            <div className="space-y-2">
              {[0, 1].map((i) => <div key={i} className="skeleton h-20" />)}
            </div>
          ) : sets.length === 0 ? (
            <EmptyState
              icon={<Hash className="h-5 w-5" />}
              title="Наборов пока нет"
              body="Создай набор хэштегов — вставляй в пост одним нажатием."
            />
          ) : (
            <div className="space-y-3">
              {sets.map((st) => (
                <Card key={st.id} className="p-4">
                  <div className="flex items-center gap-2">
                    <p className="text-[15px] font-bold text-text">{st.name}</p>
                    <Button variant="ghost" size="sm" onClick={() => deleteSet(st.id)} className="ml-auto text-danger-text">
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
    <AppShell title="Библиотека" subtitle="Сохранённые посты и наборы хэштегов.">
      <Suspense fallback={<div className="skeleton h-64" />}>
        <LibraryInner />
      </Suspense>
    </AppShell>
  );
}
