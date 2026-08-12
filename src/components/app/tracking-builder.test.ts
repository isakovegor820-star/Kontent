import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  composerTrackingDraftSelection,
  EMPTY_COMPOSER_TRACKING,
  parseTrackingLinks,
  parseTrackingTemplates,
  trackingBuilderError,
  validateUtmFields,
} from "./tracking-builder";

describe("TrackingBuilder contracts", () => {
  it("accepts only complete server template records", () => {
    expect(parseTrackingTemplates({
      ok: true,
      templates: [{
        id: 7,
        name: "Telegram · банкротство",
        version: 2,
        values: { utm_source: "telegram", utm_campaign: "bankruptcy" },
      }],
    })).toEqual([{
      id: 7,
      name: "Telegram · банкротство",
      version: 2,
      values: { utm_source: "telegram", utm_campaign: "bankruptcy" },
    }]);
    expect(parseTrackingTemplates({
      ok: true,
      templates: [{ id: 7, name: "Broken", version: 1, values: { utm_source: 42 } }],
    })).toBeNull();
  });

  it("uses calm, actionable recovery copy", () => {
    expect(trackingBuilderError({ error: "invalid_destination" })).toContain("полный адрес публичного сайта");
    expect(trackingBuilderError({ error: "invalid_utm" })).toContain("email и телефон");
    expect(trackingBuilderError({ error: "network" })).toContain("Проверь подключение");
  });

  it("parses revocable links and reports the exact invalid UTM field", () => {
    expect(parseTrackingLinks({
      ok: true,
      links: [{
        id: 41,
        slug: "abcdefghijklmnopqrstuv",
        status: "active",
        version: 2,
        expiresAt: "2026-09-11T10:00:00.000Z",
      }],
    }))?.toHaveLength(1);
    expect(parseTrackingLinks({ ok: true, links: [{ id: 41, status: "paused" }] })).toBeNull();
    expect(validateUtmFields({
      utm_source: "telegram",
      utm_campaign: "egor@example.ru",
      utm_content: "x".repeat(161),
    })).toEqual({
      utm_campaign: "Убери электронную почту или телефон.",
      utm_content: "Сократи значение до 160 символов.",
    });
  });

  it("turns only a complete public tracking form into a draft snapshot", () => {
    expect(composerTrackingDraftSelection({ ...EMPTY_COMPOSER_TRACKING, utmValues: {} })).toEqual({
      selection: null,
      error: null,
    });
    expect(composerTrackingDraftSelection({
      ...EMPTY_COMPOSER_TRACKING,
      destination: " https://example.test/consultation ",
      utmValues: { utm_source: " telegram ", utm_campaign: "bankruptcy_august" },
      placement: "cta",
    })).toEqual({
      selection: {
        shortLinkId: null,
        shortUrlPath: null,
        destination: "https://example.test/consultation",
        utmValues: { utm_source: "telegram", utm_campaign: "bankruptcy_august" },
        placement: "cta",
      },
      error: null,
    });
    expect(composerTrackingDraftSelection({
      ...EMPTY_COMPOSER_TRACKING,
      destination: "http://localhost/internal",
      utmValues: {},
    }).error).toContain("публичный адрес");
  });

  it("rejects a stale short-link binding before autosave", () => {
    expect(composerTrackingDraftSelection({
      ...EMPTY_COMPOSER_TRACKING,
      destination: "https://example.test/consultation",
      shortLinkId: 19,
      shortUrlPath: "/r/too-short",
      utmValues: {},
    }).error).toContain("заново");
  });

  it("keeps the contextual tool semantic, labelled and narrow-screen safe", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/components/app/tracking-builder.tsx"), "utf8");
    expect(source).toContain("<details");
    expect(source).toContain("<summary");
    expect(source).toContain("<fieldset");
    expect(source).toContain("<legend");
    expect(source).toContain("<select");
    expect(source).toContain("aria-invalid=");
    expect(source).toContain("aria-describedby=");
    expect(source).toContain("utmRefs.current[firstInvalidUtm]?.focus()");
    expect(source).toContain("Срок ссылки");
    expect(source).toContain("Отозвать ссылку");
    expect(source).toContain('role="status"');
    expect(source).toContain("min-h-11");
    expect(source).toContain("break-all");
    expect(source).toContain("motion-reduce:transition-none");
    expect(source).not.toContain("transition-all");
  });
});
