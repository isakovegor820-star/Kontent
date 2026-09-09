import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const pageSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const shellSource = readFileSync(new URL("../../../components/app/shell.tsx", import.meta.url), "utf8");

describe("Studio responsive recovery controls", () => {
  it("allows a long suggested engine label to wrap on narrow screens", () => {
    expect(pageSource).toContain("flex flex-col items-stretch gap-3");
    expect(pageSource).toContain("w-full whitespace-normal text-pretty sm:w-auto sm:shrink-0");
  });

  it("uses one App Router history entry for the one-shot reference flow", () => {
    expect(pageSource).toContain('const composerHref = `/app/composer?draft=${result.draft.id}&from=studio${suggestMedia}`');
    const replaceIndex = pageSource.indexOf('window.history.replaceState(window.history.state, "", `/app/studio?draft=${generation.referenceDraftId}`)');
    const pushIndex = pageSource.indexOf("router.push(composerHref)", replaceIndex);

    expect(replaceIndex).toBeGreaterThan(-1);
    expect(pushIndex).toBeGreaterThan(replaceIndex);
    expect(pageSource).not.toContain("window.location.assign(composerHref)");
  });

  it("keeps fallback diagnostics internal without a caption or toast", () => {
    expect(pageSource.includes("Запрошенная модель:")).toBe(false);
    expect(pageSource.includes("Итоговый проход:")).toBe(false);
    expect(pageSource.includes("Ответ создаёт резервная модель")).toBe(false);
    expect(pageSource).toContain('event.type === "fallback"');
  });

  it("shows only ready text models in a clearly separate model control", () => {
    expect(pageSource).toContain("readyStudioEngines(d.engines ?? [])");
    expect(pageSource).toContain("Вариант Авроры:");
    expect(pageSource).toContain("Аврора временно недоступна");
  });

  it("offers images in the dedicated workspace and keeps the chat menu focused on text", () => {
    expect(shellSource).toContain('{ href: "/app/studio?mode=media", label: "Изображения" }');
    expect(pageSource).toContain('aria-label="Режим Изображения"');
    expect(pageSource).not.toContain('id: "video"');
    expect(pageSource).not.toContain('id: "image"');
    expect(pageSource).not.toContain("Создать рилс");
  });
});
