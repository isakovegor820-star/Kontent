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

  it("keeps editing and calendar rescheduling behind role gates without a publication modal", () => {
    expect(source).toContain("{canEdit && (");
    expect(source).toContain("onAdd={canEdit ? () => addPostOn(day) : undefined}");
    expect(source).toContain("onRetry={canPublish");
    expect(source).toContain("onReschedule={canPublish");
    expect(source).toContain("canManageCalendarMove(post)");
    expect(source).not.toContain("<PublicationActionsDialog");
    expect(source).not.toContain("Управление публикацией");
    expect(source).not.toContain('className="w-9 px-0"');
  });

  it("keeps status and neutral read-only access visible", () => {
    expect(source).toContain("calendarRecordStatus(post)");
    expect(source).toContain("CALENDAR_STATUS_LABEL[visibleStatus]");
    expect(source).toContain("CALENDAR_STATUS_LABEL[editorialStatus]");
    expect(source).toContain("onClick={() => openPost(p)}");
    expect(source).toContain("Открыть черновик в редакторе:");
  });

  it("opens drafts and linked publications directly in the editor and keeps deletion out of the calendar", () => {
    expect(source).toContain("serverDraftId: rp.publication_draft_id ?? undefined");
    expect(source).toContain("activePublicationOperationForDraft(realCalendarPosts, post.serverDraftId)");
    expect(source).toContain("`&publication=${linkedOperationId}`");
    expect(source).toContain("collapsePublishedDraftDuplicates");
    expect(source).toContain("router.push(`/app/composer?draft=${post.serverDraftId}${publication}&from=calendar`)");
    expect(source).toContain('id={`calendar-open-${post.id}`}');
    expect(source).toContain("Открыть публикацию в редакторе:");
    expect(source).not.toContain("CalendarDraftActionsDialog");
    expect(source).not.toContain('aria-label="Удалить черновик"');
    expect(source).not.toContain("deleteDraftAfterAck");
  });

  it("removes cancelled publications from every calendar view while keeping drafts", () => {
    const gridStatuses = source.match(/const GRID_STATUSES:[\s\S]*?\n\];/)?.[0] ?? "";
    expect(source).toContain(".filter(calendarRecordIsVisible)");
    expect(gridStatuses).not.toContain('"cancelled"');
    expect(gridStatuses).toContain('"draft"');
  });

  it("contains the seven-column board in its own mobile scroll region", () => {
    expect(source).toContain('"group/day relative min-w-0 flex min-h-[27rem] flex-col');
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

  it("aligns the supporting calendar cards to one bottom edge on wide screens", () => {
    expect(source).toContain('className="grid gap-4 lg:grid-cols-2 lg:items-stretch"');
  });

  it("moves eligible weekly cards between future days and persists the new date", () => {
    expect(source).toContain('data-calendar-draggable={canMove && !moving ? "true" : undefined}');
    expect(source).toContain("<CalendarDragOverlay");
    expect(source).toContain("<LayoutGroup");
    expect(source).toContain("setOptimisticSchedules");
    expect(source).toContain("withOptimisticCalendarSchedule");
    expect(source).toContain("movingPostRef.current");
    expect(source).toContain("resolveCalendarDayMove");
    expect(source).toContain("rescheduleServerDraft");
    expect(source).toContain("reschedulePublication");
    expect(source).toContain("Отпустите здесь");
    expect(source).toContain("Время публикации сохранено");
    expect(source).toContain('role="status" aria-live="polite"');
  });

  it("supports long-press pointer dragging on touch screens without breaking scroll", () => {
    expect(source).toContain("createCalendarLongPressDrag");
    expect(source).toContain("startPointerSession");
    expect(source).toContain("onPointerMove={movePointerSession}");
    expect(source).toContain("onPointerCancel={cancelPointerSession}");
    expect(source).toContain('window.addEventListener("touchmove", blocker, { passive: false })');
    expect(source).toContain('document.elementFromPoint(point.clientX, point.clientY)');
    expect(source).toContain("calendarDragAutoScrollDelta");
    expect(source).toContain("на телефоне удерживайте её");
    expect(source).toContain("startPointerSession(event, true)");
    expect(source).toContain("data-calendar-week-scroller");
    expect(source).toContain("suppressOpenUntilRef.current = Date.now() + 700");
  });

  it("restores focus after the keyboard move dialog removes inert siblings", () => {
    expect(source).toContain("after the inert cleanup below");
    expect(source).toContain("previous.focus({ preventScroll: true })");
  });

  it("offers a keyboard-accessible day picker for movable cards", () => {
    expect(source).toContain("<CalendarMoveDialog");
    expect(source).toContain('aria-haspopup="dialog"');
    expect(source).toContain("Перетащить или выбрать другой день");
    expect(source).toContain('role="dialog"');
    expect(source).toContain('if (event.key === "Escape")');
  });

  it("only makes scheduled publications draggable", () => {
    expect(source).toContain('post.status === "scheduled"');
    expect(source).toContain("canManageCalendarMove(post)");
  });

  it("preserves stale cards and exposes partial/offline recovery without a reload", () => {
    expect(source).not.toContain("setServerDrafts([])");
    expect(source).toContain("calendarPartiallyStale");
    expect(source).toContain("Уже загруженные карточки сохранены");
    expect(source).toContain("void s.refreshReal()");
    expect(source).toContain("void refreshDrafts(s.user)");
  });

  it("uses the project date for today and advances it while the calendar stays open", () => {
    expect(source).toContain("calendarDayForInstant(new Date(calendarClock).toISOString(), calendarTimezone)");
    expect(source).toContain("setAnchor(today)");
    expect(source).toContain("setInterval(() => setCalendarClock(Date.now()), 60_000)");
  });

  it("shows daily scenario, trend and rotating format suggestions for signed-in projects", () => {
    expect(source).toContain("buildCalendarDailySuggestions");
    expect(source).toContain("calendarSuggestionComposerHref");
    expect(source).toContain("Каждый день — новый сценарий, тренд-разбор");
    expect(source).not.toContain("const suggestions = s.user ? []");
  });
});
