"use client";

import { RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";

export function SettingsSaveBar({ dirty, saving, scope, onSave, onCancel, label = "Сохранить изменения" }: {
  dirty: boolean; saving: boolean; scope: string; onSave: () => void; onCancel: () => void; label?: string;
}) {
  if (!dirty && !saving) return null;
  return (
    <div className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 rounded-md border border-brand/30 bg-surface p-3 shadow-soft sm:p-4" data-settings-save-bar>
      <div className="min-w-0 flex-1 basis-48">
        <p role="status" className="text-[14px] font-bold text-text">{saving ? "Сохраняем…" : "Есть несохранённые изменения"}</p>
        <p className="mt-1 text-[13px] leading-relaxed text-text-2">{scope}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onCancel}><RotateCcw className="h-4 w-4" aria-hidden />Отменить</Button>
        <Button type="button" variant="brand" size="sm" loading={saving} onClick={onSave}><Save className="h-4 w-4" aria-hidden />{label}</Button>
      </div>
    </div>
  );
}
