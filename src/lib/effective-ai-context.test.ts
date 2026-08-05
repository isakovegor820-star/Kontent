import { describe, expect, it } from "vitest";
import { selectEffectiveProfile, selectStyleSamples } from "./effective-ai-context";

describe("effective channel profile", () => {
  it("не даёт legacy-мусору profile_edit перекрыть подтверждённый brief", () => {
    const result = selectEffectiveProfile([
      {
        id: "junk-edit",
        kind: "profile_edit",
        verified: false,
        ready: true,
        updatedAt: "2026-08-01T10:00:00Z",
        fields: { niche: "аоао", audience: "ава аавоа" },
      },
      {
        id: "brief",
        kind: "verified_brief",
        verified: true,
        ready: true,
        updatedAt: "2026-07-30T10:00:00Z",
        fields: {
          niche: "Технологии и право",
          audience: "Юристы и руководители юридических команд",
          goal: "Новая культура юридического бизнеса",
        },
      },
    ]);

    expect(result.niche).toMatchObject({ value: "Технологии и право", sourceId: "brief" });
    expect(result.audience).toMatchObject({ sourceId: "brief" });
  });

  it("применяет подтверждённую ручную правку только к её полю", () => {
    const result = selectEffectiveProfile([
      {
        id: "brief",
        kind: "verified_brief",
        verified: true,
        ready: true,
        fields: { niche: "Технологии и право", audience: "Юристы и руководители" },
      },
      {
        id: "edit",
        kind: "profile_edit",
        verified: true,
        ready: true,
        fields: { audience: "Юристы, руководители и разработчики legal tech" },
      },
    ]);

    expect(result.niche?.sourceId).toBe("brief");
    expect(result.audience).toMatchObject({ sourceId: "edit", verified: true });
  });
});

describe("verified style samples", () => {
  it("берёт только ручные или подтверждённые снаружи примеры", () => {
    const selected = selectStyleSamples([
      {
        id: "manual",
        text: "Ручной пример голоса автора, подтверждённый владельцем канала.",
        origin: "rss",
        manuallyApproved: true,
        externalState: "unknown",
      },
      {
        id: "live",
        text: "Публикация Авроры существует во внешнем канале и подходит как образец.",
        origin: "aurora_published",
        manuallyApproved: false,
        externalState: "present",
      },
      {
        id: "deleted",
        text: "Эта публикация была удалена с площадки и не должна влиять на стиль.",
        origin: "aurora_published",
        manuallyApproved: false,
        externalState: "deleted",
      },
      {
        id: "rss",
        text: "Импортированный RSS-текст без подтверждения автора не является его голосом.",
        origin: "rss",
        manuallyApproved: false,
        externalState: "unknown",
      },
    ]);

    expect(selected).toEqual([
      expect.objectContaining({ id: "manual", provenance: "manual_approved" }),
      expect.objectContaining({ id: "live", provenance: "externally_verified" }),
    ]);
  });
});
