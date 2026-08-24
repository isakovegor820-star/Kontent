import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("calendar role-aware interface", () => {
  it("maps project roles to the two calendar capabilities", () => {
    expect(source).toContain(
      'canEdit: role === "owner" || role === "author" || role === "approver"',
    );
    expect(source).toContain(
      'canPublish: role === "owner" || role === "publisher"',
    );
    expect(source).toContain("const projects = useProjects()");
    expect(source).toContain("calendarRoleCapabilities(currentRole)");
  });

  it("offers scheduling only to publishers of editorially approved drafts", () => {
    expect(source).toContain('if (canPublish && status === "approved")');
    expect(source).toContain('return { kind: "schedule", label: "Запланировать" }');
    expect(source).toContain("calendarQueueAction(currentRole, editorialStatus)");
    expect(source).toContain('action.kind === "schedule"');
    expect(source).toContain('return { kind: "review", label: "Проверить" }');
    expect(source).toContain('return { kind: "open", label: "Открыть" }');
  });

  it("keeps editing and active-publication controls behind role gates", () => {
    expect(source).toContain("{canEdit && (");
    expect(source).toContain("onAdd={canEdit ? () => addPostOn(day) : undefined}");
    expect(source).toContain("onRetry={canPublish");
    expect(source).toContain("onReschedule={canPublish");
    expect(source).toContain("{canInspectPublication && (");
    expect(source).toContain("<PublicationActionsDialog");
    expect(source).toContain("canManageSchedule={canPublish}");
    expect(source).not.toContain('className="w-9 px-0"');
  });

  it("keeps status and neutral read-only access visible", () => {
    expect(source).toContain("calendarRecordStatus(post)");
    expect(source).toContain("CALENDAR_STATUS_LABEL[visibleStatus]");
    expect(source).toContain("CALENDAR_STATUS_LABEL[editorialStatus]");
    expect(source).toContain("onClick={() => openPost(p)}");
    expect(source).toContain("Открыть черновик в редакторе:");
  });

  it("opens server drafts directly in the editor and keeps deletion out of the calendar", () => {
    expect(source).toContain("router.push(`/app/composer?draft=${post.serverDraftId}&from=calendar`)");
    expect(source).toContain('id={`calendar-open-${post.id}`}');
    expect(source).not.toContain("CalendarDraftActionsDialog");
    expect(source).not.toContain('aria-label="Удалить черновик"');
    expect(source).not.toContain("deleteDraftAfterAck");
  });

  it("contains the seven-column board in its own mobile scroll region", () => {
    expect(source).toContain('"group/day min-w-0 flex min-h-[27rem] flex-col');
    expect(source).toContain('"relative min-w-0 rounded-sm border-l-2');
    expect(source).toContain('className="-mx-4 overflow-x-auto overscroll-x-contain');
    expect(source).toContain('className="grid min-w-[64rem] grid-cols-7 gap-2 xl:min-w-0"');
  });

  it("implements the variant-one calendar hierarchy", () => {
    expect(source).toContain('type View = "week" | "month" | "list"');
    expect(source).toContain("Планируйте, публикуйте и отслеживайте контент.");
    expect(source).toContain("Статистика недели");
    expect(source).toContain("Ближайшие публикации");
    expect(source).toContain("Постов на неделе");
    expect(source).toContain("Вовлечённость");
  });

  it("moves eligible weekly cards between future days and persists the new date", () => {
    expect(source).toContain('data-calendar-draggable={canMove && !moving ? "true" : undefined}');
    expect(source).toContain('draggable={canMove && !moving}');
    expect(source).toContain('const CALENDAR_DRAG_MIME = "application/x-aurora-calendar-post"');
    expect(source).toContain("resolveCalendarDayMove");
    expect(source).toContain("rescheduleServerDraft");
    expect(source).toContain("reschedulePublication");
    expect(source).toContain("Перенести сюда");
    expect(source).toContain("Время публикации сохранено");
    expect(source).toContain('role="status" aria-live="polite"');
  });

  it("supports long-press pointer dragging on touch screens without breaking scroll", () => {
    expect(source).toContain("createCalendarLongPressDrag");
    expect(source).toContain("onPointerDown={(event) =>");
    expect(source).toContain("onPointerMove={(event) =>");
    expect(source).toContain("onPointerCancel={(event) =>");
    expect(source).toContain('window.addEventListener("touchmove", blocker, { passive: false })');
    expect(source).toContain('document.elementFromPoint(point.clientX, point.clientY)');
    expect(source).toContain("calendarDragAutoScrollDelta");
    expect(source).toContain("Удерживайте карточку до подсветки");
  });

  it("only makes scheduled publications draggable", () => {
    expect(source).toContain('post.status === "scheduled"');
    expect(source).toContain("canManageCalendarMove(post)");
  });
});
