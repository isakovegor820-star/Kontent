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

  it("keeps edit, destructive and active-publication controls behind role gates", () => {
    expect(source).toContain("{canEdit && (");
    expect(source).toContain("onAdd={canEdit ? () => addPostOn(day) : undefined}");
    expect(source).toContain("onRetry={canPublish");
    expect(source).toContain("onReschedule={canPublish");
    expect(source).toContain("{canInspectPublication && (");
    expect(source).toContain("<PublicationActionsDialog");
    expect(source).toContain("canManageSchedule={canPublish}");
    expect(source).toContain('className="w-11 px-0"');
    expect(source).not.toContain('className="w-9 px-0"');
  });

  it("keeps status and neutral read-only access visible", () => {
    expect(source).toContain("calendarRecordStatus(post)");
    expect(source).toContain("CALENDAR_STATUS_LABEL[visibleStatus]");
    expect(source).toContain("CALENDAR_STATUS_LABEL[editorialStatus]");
    expect(source).toContain("onClick={() => openPost(p)}");
    expect(source).toContain("Открыть публикацию:");
  });

  it("allows weekly cards to shrink inside a narrow mobile viewport", () => {
    expect(source).toContain('"group/day min-w-0 flex flex-col rounded-md');
    expect(source).toContain('"relative min-w-0 rounded-sm border-l-2');
    expect(source).toContain('className="grid min-w-0 gap-2 xl:grid-cols-7"');
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

  it("only makes scheduled publications draggable", () => {
    expect(source).toContain('post.status === "scheduled"');
    expect(source).toContain("canManageCalendarMove(post)");
  });
});
