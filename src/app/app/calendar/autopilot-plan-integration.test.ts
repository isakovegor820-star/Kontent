import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const card = readFileSync(new URL("../../../components/app/autopilot-plan-calendar.tsx", import.meta.url), "utf8");

describe("план автопилота в основном календаре", () => {
  it("берёт неподтверждённый план отдельным слоем, а не подмешивает его в публикации", () => {
    expect(page).toContain("useAutopilotPlan(s.ready ? currentProjectId : undefined, s.realPosts)");
    expect(page).toContain("const planItems = useMemo(");
    expect(page).toContain("planItems={dayPlanItems(day)}");
    expect(page).toContain("onOpenPlan={(item) => setOpenPlanKey(item.key)}");
    expect(page).toContain("planCount={dayPlanItems(day).length}");
  });

  it("показывает план в неделе, месяце и списке, уважая скрытые каналы", () => {
    expect(page).toContain("autopilotPlan.items.filter((item) => item.channelId == null || !hidden.has(item.channelId))");
    expect(page).toContain("<AutopilotPlanCard");
    expect(page).toContain("в плане автопилота");
    expect(card).toContain("План автопилота");
    expect(card).toContain("data-autopilot-plan-card={item.key}");
  });

  it("подтверждает пост только точным preview → confirm с идемпотентным ключом", () => {
    expect(page).toContain('fetch("/api/autopilot/approve"');
    expect(page).toContain('action: "preview"');
    expect(page).toContain('action: "confirm"');
    expect(page).toContain("previewToken: preview.token");
    expect(page).toContain("previewHash: preview.hash");
    expect(page).toContain("idempotencyKey");
    expect(page).toContain("if (planBusy || !item.selectable || !item.channelId) return;");
    expect(card).toContain("disabled={busy || !item.selectable}");
  });

  it("не выдаёт сбой загрузки плана за пустой календарь", () => {
    expect(page).toContain("autopilotPlan.error");
    expect(page).toContain("План автопилота не удалось загрузить");
    expect(page).toContain("autopilotPlan.truncated");
    expect(page).toContain("Обновить план");
  });

  it("не выдаёт неудачный предпросмотр за «уже обработан»", () => {
    // 409 stale_preview приходит вместе со свежим token: если он есть — план изменился,
    // и человеку нельзя говорить «повторная постановка не нужна».
    expect(page).toContain("if (!preview?.token)");
    expect(page).toContain('title: "Не удалось проверить план"');
    expect(page).toContain('title: "План уже обработан"');
  });

  it("переносит время только через плановый маршрут автопилота", () => {
    expect(page).toContain('fetch("/api/autopilot/item/schedule"');
    expect(page).toContain("planRevision: item.planRevision");
    expect(page).toContain("if (planBusy || !item.editable) return false;");
  });

  it("не выдаёт пост автопилота за публикацию в интерфейсе", () => {
    expect(card).toContain("Публикация появится");
    expect(card).toContain("только после твоего подтверждения");
  });
});
