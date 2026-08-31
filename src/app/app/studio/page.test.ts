import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const pageSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const shellSource = readFileSync(new URL("../../../components/app/shell.tsx", import.meta.url), "utf8");

describe("Studio responsive recovery controls", () => {
  it("allows a long suggested engine label to wrap on narrow screens", () => {
    expect(pageSource).toContain("flex flex-col items-stretch gap-3");
    expect(pageSource).toContain("w-full whitespace-normal text-pretty sm:w-auto sm:shrink-0");
  });

  it("uses one native history entry for the one-shot reference flow", () => {
    expect(pageSource).toContain('const composerHref = `/app/composer?draft=${result.draft.id}&from=studio${suggestMedia}`');
    expect(pageSource).toContain('window.history.replaceState(window.history.state, "", `/app/studio?draft=${generation.referenceDraftId}`)');
    expect(pageSource).toContain("window.location.assign(composerHref)");
    expect(pageSource.indexOf("window.location.assign(composerHref)")).toBeLessThan(
      pageSource.indexOf("router.push(composerHref)"),
    );
  });

  it("does not render provider fallback provenance as permanent message text", () => {
    expect(pageSource).not.toContain("Запрошенная модель:");
    expect(pageSource).not.toContain("Итоговый проход:");
    expect(pageSource).not.toContain("В ходе генерации использовался резервный маршрут");
  });

  it("shows only ready text models in a clearly separate model control", () => {
    expect(pageSource).toContain("readyStudioEngines(d.engines ?? [])");
    expect(pageSource).toContain("Модель · ${activeEngine.label}");
    expect(pageSource).toContain("Сейчас нет доступных моделей");
  });

  it("exposes the media workspace as images only", () => {
    expect(shellSource).toContain('{ href: "/app/studio?mode=media", label: "Картинки" }');
    expect(shellSource).not.toContain("Картинки и видео");
    expect(pageSource).toContain('aria-label="Режим Картинки"');
    expect(pageSource).not.toContain('id: "video"');
    expect(pageSource).not.toContain("Создать рилс");
    expect(pageSource).not.toContain("initialKind={mediaKind}");
  });
});
