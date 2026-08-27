import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  parsePublicationFollowupResponse,
  parsePublicationReviewDecisionResponse,
  publicationExtraStatus,
  publicationFollowupError,
} from "./publication-followup-client";

it("parses immutable fingerprints and review versions from operation detail", () => {
  const parsed = parsePublicationFollowupResponse({
    ok: true,
    operation: {
      destinations: [{
        postId: 12,
        network: "tg",
        title: "Право",
        extraOperations: [{
          id: 7,
          kind: "first_comment",
          status: "failed",
          fingerprint: "a".repeat(64),
          attempts: 1,
          error: "delivery_unknown",
          message: "Проверьте обсуждение",
          externalUrl: null,
        }],
        review: {
          id: 8,
          responsibleUserId: 3,
          reviewAt: "2026-09-01T09:00:00.000Z",
          timezone: "Europe/Moscow",
          status: "due",
          decision: null,
          reminderStatus: "sent",
          version: 2,
          updateDraftId: 91,
          canDecide: true,
          canUnpin: true,
        },
      }],
    },
  });
  expect(parsed?.[0].extraOperations[0].fingerprint).toBe("a".repeat(64));
  expect(parsed?.[0].review?.version).toBe(2);
  expect(parsed?.[0].review).toMatchObject({
    updateDraftId: 91,
    canDecide: true,
    canUnpin: true,
  });
});

describe("publication review server authority", () => {
  const response = (review: Record<string, unknown>) => ({
    ok: true,
    operation: {
      destinations: [{
        postId: 12,
        network: "tg",
        title: "Право",
        extraOperations: [],
        review: {
          id: 8,
          responsibleUserId: 3,
          reviewAt: "2026-09-01T09:00:00.000Z",
          timezone: "Europe/Moscow",
          status: "due",
          decision: null,
          reminderStatus: "sent",
          version: 2,
          updateDraftId: null,
          canDecide: true,
          canUnpin: false,
          ...review,
        },
      }],
    },
  });

  it("rejects missing, malformed, or contradictory server capabilities", () => {
    expect(parsePublicationFollowupResponse(response({ canDecide: "yes" }))).toBeNull();
    expect(parsePublicationFollowupResponse(response({ canUnpin: 1 }))).toBeNull();
    expect(parsePublicationFollowupResponse(response({ canDecide: false, canUnpin: true }))).toBeNull();
    expect(parsePublicationFollowupResponse(response({ updateDraftId: "91" }))).toBeNull();
    expect(parsePublicationFollowupResponse(response({ updateDraftId: 0 }))).toBeNull();

    const missingDraftId = response({});
    delete (missingDraftId.operation.destinations[0].review as Record<string, unknown>).updateDraftId;
    expect(parsePublicationFollowupResponse(missingDraftId)).toBeNull();

    const missingCanDecide = response({});
    delete (missingCanDecide.operation.destinations[0].review as Record<string, unknown>).canDecide;
    expect(parsePublicationFollowupResponse(missingCanDecide)).toBeNull();

    const missingCanUnpin = response({});
    delete (missingCanUnpin.operation.destinations[0].review as Record<string, unknown>).canUnpin;
    expect(parsePublicationFollowupResponse(missingCanUnpin)).toBeNull();
  });

  it("parses the linked review draft only from a strict successful response", () => {
    expect(parsePublicationReviewDecisionResponse({ ok: true, draftId: 91 })).toEqual({ draftId: 91 });
    expect(parsePublicationReviewDecisionResponse({ ok: true, draftId: null })).toEqual({ draftId: null });
    expect(parsePublicationReviewDecisionResponse({ ok: true, draftId: "91" })).toBeNull();
    expect(parsePublicationReviewDecisionResponse({ ok: true })).toBeNull();
    expect(parsePublicationReviewDecisionResponse({ ok: false, draftId: 91 })).toBeNull();
  });

  it("keeps follow-up actions in the editor after calendar clicks bypass the removed modal", async () => {
    const section = await readFile(
      new URL("../components/app/publication-followup-section.tsx", import.meta.url),
      "utf8",
    );
    const composer = await readFile(
      new URL("../app/app/composer/page.tsx", import.meta.url),
      "utf8",
    );
    const calendar = await readFile(
      new URL("../app/app/calendar/page.tsx", import.meta.url),
      "utf8",
    );

    expect(section).toContain("destination.review.canDecide");
    expect(section).toContain("destination.review.canUnpin");
    expect(section).not.toContain("currentUserId === destination.review.responsibleUserId");
    expect(section).toContain("onUpdateRequested(parsed.draftId)");
    expect(section).toContain("aria-busy={loading || Boolean(busyKey) || undefined}");
    expect(section).toContain("loading={busyKey === `review:${destination.review.id}:update`}");
    expect(composer).toContain("<PublicationFollowupSection");
    expect(composer).toContain("onUpdateRequested={(nextDraftId)");
    expect(composer).toContain("restorePublicationToDraft");
    expect(composer).toContain("Обновить публикацию");
    expect(calendar).not.toContain("restorePublicationToDraft");
    expect(calendar).not.toContain("PublicationActionsDialog");
    expect(calendar).toContain("`&publication=${post.publicationOperationId}`");
  });
});

it("uses honest visible states and ambiguity copy", () => {
  expect(publicationExtraStatus({ status: "unsupported" } as never).label).toContain("Недоступно");
  expect(publicationFollowupError({ error: "provider_confirmation_required" })).toContain("подтвердите");
});
