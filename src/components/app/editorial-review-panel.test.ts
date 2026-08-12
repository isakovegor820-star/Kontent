import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("EditorialReviewPanel interface contract", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/components/app/editorial-review-panel.tsx"),
    "utf8",
  );

  it("keeps every decision bound to the exact revision and request snapshot", () => {
    expect(source).toContain("submitEditorialReview(saved.id, current)");
    expect(source).toContain("decideEditorialReview(draftId!, current, decision");
    expect(source).toContain("snapshot.request.revisionId === snapshot.currentRevision.id");
    expect(source).toContain("Смысловая правка снимет согласование");
  });

  it("preserves comments on failed mutations and exposes the journal", () => {
    expect(source).toContain("if (await refreshAfter(\"comment\"");
    expect(source).toContain("История согласования");
    expect(source).toContain("snapshot.comments.map");
    expect(source).toContain("snapshot.decisions.map");
    expect(source).toContain("whitespace-pre-wrap break-words");
  });

  it("uses native labelled forms, announced errors and mobile-safe controls", () => {
    expect(source).toContain("<form");
    expect(source).toContain("<fieldset");
    expect(source).toContain("<legend");
    expect(source).toContain("<label htmlFor={noteId}");
    expect(source).toContain("aria-invalid={noteInvalid");
    expect(source).toContain("aria-describedby={noteInvalid");
    expect(source).toContain('role="alert"');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain("min-h-11");
    expect(source).toContain('className="h-auto max-w-full whitespace-normal text-center"');
    expect(source).not.toContain("transition-all");
  });

  it("keeps role-specific actions honest", () => {
    expect(source).toContain("capabilities.canSubmit");
    expect(source).toContain("capabilities.canReview");
    expect(source).toContain("capabilities.readOnly");
    expect(source).toContain("Публикатор видит историю и статус");
  });

  it("turns the personal-project self-review into one explicit confirmation", () => {
    expect(source).toContain("personalProject");
    expect(source).toContain("confirmPersonalPost");
    expect(source).toContain("approvePersonalDraftForPublication(saved.id, saved.version)");
    expect(source).toContain("Подтвердить пост");
    expect(source).toContain("Пост подтверждён. Теперь выберите время");
  });

  it("refreshes readiness after autosave creates a new immutable revision", () => {
    expect(source).toContain("previousSaveStateRef");
    expect(source).toContain('draftSaveState === "saved"');
    expect(source).toContain('previous !== "saved"');
    expect(source).toContain("void load(draftId)");
  });

  it("does not let an older snapshot overwrite a completed decision", () => {
    expect(source).toContain("snapshotRequestRef");
    expect(source).toContain("requestSequence === snapshotRequestRef.current");
    expect(source).toContain("Invalidate a background snapshot started before this mutation");
  });
});
