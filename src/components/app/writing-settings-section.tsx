"use client";

import { useState } from "react";
import { BookOpenCheck, FileText } from "lucide-react";
import { BrandDictionarySection } from "./brand-dictionary-section";
import { PublicationBlocksSection } from "./publication-blocks-section";

export function WritingSettingsSection() {
  const [view, setView] = useState<"rules" | "templates">("rules");

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 rounded-sm border border-line bg-surface p-1.5" role="group" aria-label="Правила и шаблоны текста">
        {([
          { id: "rules", label: "Правила написания", icon: BookOpenCheck },
          { id: "templates", label: "Шаблоны для постов", icon: FileText },
        ] as const).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-pressed={view === id}
            aria-controls={`writing-${id}`}
            onClick={() => setView(id)}
            className={`flex min-h-12 items-center justify-center gap-2 rounded-xs px-3 py-2 text-[13px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-brand ${view === id ? "bg-info-soft text-info-text" : "text-text-3 hover:bg-surface-2 hover:text-text"}`}
          >
            <Icon className="hidden h-4 w-4 shrink-0 sm:block" aria-hidden />
            {label}
          </button>
        ))}
      </div>
      <div id="writing-rules" hidden={view !== "rules"}><BrandDictionarySection /></div>
      <div id="writing-templates" hidden={view !== "templates"}><PublicationBlocksSection /></div>
    </div>
  );
}
