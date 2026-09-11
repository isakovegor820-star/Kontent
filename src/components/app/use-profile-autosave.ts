"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountProfile, AccountProfilePatch } from "@/lib/account-settings";

export function useProfileAutosave(onIdentitySaved: () => Promise<unknown>) {
  const [draft, setDraft] = useState<AccountProfile | null>(null);
  const [saved, setSaved] = useState<AccountProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState("");
  const current = useRef<AccountProfile | null>(null);
  const pending = useRef<AccountProfilePatch>({});
  const running = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    if (running.current || !Object.keys(pending.current).length) return;
    running.current = true;
    setSaving(true);
    setError("");
    try {
      while (Object.keys(pending.current).length) {
        const patch = pending.current;
        pending.current = {};
        try {
          const response = await fetch("/api/settings/account-profile", {
            method: "PATCH", headers: { "content-type": "application/json" },
            body: JSON.stringify(patch), keepalive: true,
          });
          const body = await response.json() as { ok?: boolean; patch?: AccountProfilePatch; savedAt?: string };
          if (!response.ok || !body.ok || !body.patch) throw new Error("save_failed");
          const accepted = body.patch;
          setSaved((previous) => previous ? { ...previous, ...accepted } : previous);
          // An old response may normalize its own values, but cannot replace newer edits.
          for (const key of Object.keys(patch) as Array<keyof AccountProfilePatch>) {
            if (current.current && current.current[key] === patch[key]) {
              current.current = { ...current.current, [key]: accepted[key] };
            }
          }
          setDraft(current.current);
          setSavedAt(body.savedAt ?? new Date().toISOString());
          if ("avatar" in patch || "displayName" in patch) void onIdentitySaved().catch(() => undefined);
        } catch {
          pending.current = { ...patch, ...pending.current };
          setError("Не удалось сохранить изменения. Проверь соединение и повтори попытку.");
          break;
        }
      }
    } finally {
      running.current = false;
      setSaving(false);
    }
  }, [onIdentitySaved]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    // Finish already requested personal edits when navigating to another panel.
    void flush();
  }, [flush]);

  const initialize = useCallback((profile: AccountProfile, timestamp = "") => {
    current.current = profile;
    pending.current = {};
    setSaved(profile);
    setDraft(profile);
    setSavedAt(timestamp);
  }, []);

  const update = <K extends keyof AccountProfilePatch>(key: K, value: NonNullable<AccountProfilePatch[K]>) => {
    if (!current.current) return;
    current.current = { ...current.current, [key]: value };
    setDraft(current.current);
    if (key === "displayName" && !String(value).trim()) {
      delete pending.current.displayName;
      setError("Укажи отображаемое имя.");
      return;
    }
    pending.current = { ...pending.current, [key]: value };
    setError("");
    if (timer.current) clearTimeout(timer.current);
    if (key === "avatar" || key === "locale" || key === "timezone") void flush();
    else timer.current = setTimeout(() => void flush(), 600);
  };

  const mergeVerifiedContact = (phone: string) => {
    if (current.current) current.current = { ...current.current, phone };
    setDraft(current.current);
    setSaved((previous) => previous ? { ...previous, phone } : previous);
  };

  return { draft, saved, saving, error: draft && !draft.displayName.trim() ? "Укажи отображаемое имя." : error, setError, savedAt, initialize, update, flush, mergeVerifiedContact,
    dirty: Boolean(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved)) };
}
