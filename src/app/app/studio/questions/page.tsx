"use client";

import { AppShell } from "@/components/app/shell";
import { AudienceAssistantPanel } from "@/components/studio/audience-assistant-panel";

export default function AudienceQuestionsPage() {
  return (
    <AppShell
      title="Помощник по аудитории"
      subtitle="Не пропускайте комментарии и отвечайте увереннее — Аврора поможет разобрать сообщение и подготовить ответ."
    >
      <div className="mx-auto w-full max-w-[1450px]">
        <AudienceAssistantPanel />
      </div>
    </AppShell>
  );
}
