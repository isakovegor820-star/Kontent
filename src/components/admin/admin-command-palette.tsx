"use client";

import { checkAdminAccess } from "./admin-ui";

import { BriefcaseBusiness, Search, Send, UserRound, type LucideIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { AdminSearchHit, AdminSearchResponse } from "@/lib/admin-search";
import { adminProjectsHref, adminPublicationsHref, adminUsersHref } from "@/lib/admin-url-state";
import { useModalFocus } from "@/components/ui/use-modal-focus";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<AdminSearchHit["kind"], string> = { user: "Пользователи", project: "Проекты", post: "Публикации" };
const KIND_ICON: Record<AdminSearchHit["kind"], LucideIcon> = { user: UserRound, project: BriefcaseBusiness, post: Send };

export function adminSearchHitHref(hit: AdminSearchHit): string {
  switch (hit.kind) {
    case "user":
      return adminUsersHref("/admin", { user: hit.id });
    case "project":
      return adminProjectsHref("/admin", { prid: hit.id });
    case "post":
      return adminPublicationsHref("/admin", { pq: hit.id, pstatus: "all" });
  }
}

/** ⌘K / Ctrl+K: one box that finds an account, a project or a post by id, name, email or text. */
export function AdminCommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<AdminSearchResponse | null>(null);
  const [active, setActive] = useState(0);
  const [failed, setFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const listId = useId();
  const triggerId = useId();
  const { overlayRef, dialogRef, onKeyDown } = useModalFocus({ open, initialFocusRef: inputRef, restoreFocusId: triggerId, onEscape: () => setOpen(false) });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);


  useEffect(() => {
    if (!open || !(query.trim().length >= 2 || /^\d+$/u.test(query.trim()))) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch(`/api/admin/search?q=${encodeURIComponent(query.trim())}`, { cache: "no-store", signal: controller.signal })
        .then(async (response) => {
        checkAdminAccess(response);
          if (!response.ok) throw new Error("unavailable");
          return response.json() as Promise<AdminSearchResponse>;
        })
        .then((payload) => {
          setResult(payload);
          setFailed(false);
          setActive(0);
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(true);
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query]);

  const searchable = query.trim().length >= 2 || /^\d+$/u.test(query.trim());
  const hits: AdminSearchHit[] = result && searchable ? [...result.users, ...result.projects, ...result.posts] : [];

  function go(hit: AdminSearchHit) {
    setOpen(false);
    window.location.assign(adminSearchHitHref(hit));
  }

  if (!open) {
    return (
      <button
        id={triggerId}
        type="button"
        onClick={() => setOpen(true)}
        className="type-caption inline-flex min-h-11 items-center gap-2 rounded-sm border border-line bg-surface px-3 text-text-3 hover:border-line-strong hover:text-text"
        aria-label="Поиск по админ-панели (⌘K)"
      >
        <Search className="h-3.5 w-3.5" aria-hidden />
        Поиск
        <kbd className="rounded-xs border border-line px-1.5 font-mono text-[11px]">⌘K</kbd>
      </button>
    );
  }

  // The sidebar uses backdrop-filter, which turns it into the containing block for
  // position: fixed; the dialog is portalled to <body> so it covers the whole page.
  return createPortal(
    <div ref={overlayRef} className="app-v3 fixed inset-0 z-50 grid place-items-start justify-center bg-text/45 p-4 pt-[12vh] backdrop-blur-sm" onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown} className="card-plain w-full max-w-2xl overflow-hidden rounded-lg p-0 shadow-float">
        <h2 id={titleId} className="sr-only">Поиск по админ-панели</h2>
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search className="h-4 w-4 shrink-0 text-text-3" aria-hidden />
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls={listId}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); setActive((value) => Math.min(hits.length - 1, value + 1)); }
              if (event.key === "ArrowUp") { event.preventDefault(); setActive((value) => Math.max(0, value - 1)); }
              if (event.key === "Enter" && hits[active]) { event.preventDefault(); go(hits[active]); }
            }}
            placeholder="ID, email, имя, проект или текст публикации"
            aria-label="Строка поиска"
            aria-activedescendant={hits[active] ? `palette-${hits[active].kind}-${hits[active].id}` : undefined}
            className="min-h-12 w-full bg-transparent text-base text-text outline-none placeholder:text-text-3"
          />
          <kbd className="type-caption rounded-xs border border-line px-1.5 text-text-3">Esc</kbd>
        </div>
        <div id={listId} className="max-h-[60vh] overflow-y-auto p-2" role="listbox" aria-label="Результаты поиска">
          {!searchable ? <p className="type-caption p-4 text-text-3">Введите минимум два символа или ID. Цифры ищутся как ID пользователя, проекта и публикации.</p> : null}
          {failed ? <p className="type-caption p-4 text-danger-text">Поиск временно недоступен.</p> : null}
          {searchable && result && hits.length === 0 && !failed ? <p className="type-caption p-4 text-text-3">Ничего не найдено по «{result.query}».</p> : null}
          {(["user", "project", "post"] as const).map((kind) => {
            const group = hits.filter((hit) => hit.kind === kind);
            if (group.length === 0) return null;
            const Icon = KIND_ICON[kind];
            return (
              <div key={kind} className="mb-2">
                <p className="type-caption px-3 py-1.5 text-text-3">{KIND_LABEL[kind]}</p>
                {group.map((hit) => {
                  const index = hits.indexOf(hit);
                  return (
                    <button
                      key={`${hit.kind}-${hit.id}`}
                      id={`palette-${hit.kind}-${hit.id}`}
                      type="button"
                      role="option"
                      aria-selected={index === active}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => go(hit)}
                      className={cn("flex w-full items-center gap-3 rounded-sm px-3 py-2 text-start", index === active ? "bg-info-soft text-info-text" : "hover:bg-surface-inset")}
                    >
                      <Icon className="h-4 w-4 shrink-0 text-text-3" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="type-secondary block truncate font-semibold text-text">{hit.title}</span>
                        <span className="type-caption block truncate text-text-3">{hit.subtitle}</span>
                      </span>
                      {hit.badge ? <span className="type-caption shrink-0 rounded-full bg-surface-inset px-2 py-0.5 text-text-2">{hit.badge}</span> : null}
                      <span className="nums type-caption shrink-0 text-text-3">#{hit.id}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
