import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { NAV_CHILDREN } from "@/lib/sidebar-navigation";

const pageSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");


describe("Studio responsive recovery controls", () => {
  it("allows a long suggested engine label to wrap on narrow screens", () => {
    expect(pageSource).toContain("flex flex-col items-stretch gap-3");
    expect(pageSource).toContain("w-full whitespace-normal text-pretty sm:w-auto sm:shrink-0");
  });

  it("uses one native document history entry for the one-shot reference flow", () => {
    expect(pageSource).toContain('const composerHref = `/app/composer?draft=${result.draft.id}&from=studio${suggestMedia}`');
    expect(pageSource).toContain('window.history.replaceState(window.history.state, "", `/app/studio?draft=${generation.referenceDraftId}`)');
    expect(pageSource).toContain("window.location.assign(composerHref)");
    expect(pageSource).toContain("this one-shot handoff intentionally resets the consumed document context");
    expect(pageSource.indexOf("window.location.assign(composerHref)")).toBeLessThan(
      pageSource.indexOf("router.push(composerHref)"),
    );
  });

  it("auto-generates an owned infopovod in chat and marks it used only after a reviewable result", () => {
    expect(pageSource).toContain("`/api/opportunities/${opportunityId}/studio`");
    expect(pageSource).toContain("setPendingGrowthMoveGeneration({");
    expect(pageSource).toContain('history: []');
    expect(pageSource).toContain('body: JSON.stringify({ state: "used" })');
    expect(pageSource).toContain("completion.reviewable && gen.opportunityId");
    expect(pageSource).not.toContain("autoOpenComposer: true,\n      resultClientKey: pending.resultClientKey,\n      channelId: pending.channelId,\n      growthMoveId: pending.moveId");
  });

  it("keeps fallback diagnostics internal without a caption or toast", () => {
    expect(pageSource.includes("Запрошенная модель:")).toBe(false);
    expect(pageSource.includes("Итоговый проход:")).toBe(false);
    expect(pageSource.includes("Ответ создаёт резервная модель")).toBe(false);
    expect(pageSource).toContain('event.type === "fallback"');
  });

  it("does not render the legacy persistence warning as a red card", () => {
    expect(pageSource).toContain("visibleStudioAiErrorRu(msg.errorMessage)");
    expect(pageSource).toContain("{visibleErrorMessage && (");
    expect(pageSource).not.toContain("{msg.errorMessage && (");
  });

  it("shows only ready text models in a clearly separate model control", () => {
    expect(pageSource).toContain("readyStudioEngines(d.engines ?? [])");
    expect(pageSource).toContain("Вариант Авроры:");
    expect(pageSource).toContain("Аврора временно недоступна");
  });

  it("offers images in the dedicated workspace and keeps the chat menu focused on text", () => {
    expect(NAV_CHILDREN.studio).toContainEqual({ href: "/app/studio?mode=media", label: "Изображения" });
    expect(pageSource).toContain('aria-label="Режим Изображения"');
    expect(pageSource).not.toContain('id: "video"');
    expect(pageSource).not.toContain('id: "image"');
    expect(pageSource).not.toContain("Создать рилс");
  });
});
