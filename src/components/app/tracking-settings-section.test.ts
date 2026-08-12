import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  parseTrackingSettingsResponse,
  parseUtmTemplatesResponse,
  trackingInstallSnippet,
  trackingSettingsErrorMessage,
} from "./tracking-settings-section";

describe("TrackingSettingsSection contracts", () => {
  it("accepts only complete server-owned tracking settings", () => {
    expect(parseTrackingSettingsResponse({
      ok: true,
      tracking: {
        status: "verification_failed",
        siteOrigin: "https://law.example.ru",
        publicKey: "tracker_public_key_1234567890",
        attributionWindowDays: 30,
        version: 2,
        verifiedAt: null,
        lastPingAt: null,
        signalReceivedAt: null,
        verificationCheckedAt: null,
        verificationErrorCode: null,
        verificationFilePath: "/.well-known/aurora-tracker-verification.txt",
        verificationFileContent: "aurora-site-verification=abcdefghijklmnopqrstuvwxyzABCDEFG",
      },
    })).toEqual({
      status: "verification_failed",
      siteOrigin: "https://law.example.ru",
      publicKey: "tracker_public_key_1234567890",
      attributionWindowDays: 30,
      version: 2,
      verifiedAt: null,
      lastPingAt: null,
      signalReceivedAt: null,
      verificationCheckedAt: null,
      verificationErrorCode: null,
      verificationFilePath: "/.well-known/aurora-tracker-verification.txt",
      verificationFileContent: "aurora-site-verification=abcdefghijklmnopqrstuvwxyzABCDEFG",
    });

    expect(parseTrackingSettingsResponse({
      ok: true,
      tracking: {
        status: "active",
        siteOrigin: null,
        publicKey: null,
        attributionWindowDays: 30,
        version: 1,
        verifiedAt: null,
        lastPingAt: null,
        signalReceivedAt: null,
        verificationCheckedAt: null,
        verificationErrorCode: null,
        verificationFilePath: "/.well-known/aurora-tracker-verification.txt",
        verificationFileContent: null,
      },
    })).toBeNull();
    expect(parseTrackingSettingsResponse({ ok: true, tracking: { status: "active" } })).toBeNull();

    expect(parseTrackingSettingsResponse({
      ok: true,
      tracking: {
        status: "paused",
        siteOrigin: "https://law.example.ru",
        publicKey: "tracker_public_key_1234567890",
        attributionWindowDays: 30,
        version: 3,
        verifiedAt: "2026-08-11T10:00:00.000Z",
        lastPingAt: "2026-08-11T10:00:00.000Z",
        signalReceivedAt: "2026-08-11T10:00:00.000Z",
        verificationCheckedAt: "2026-08-11T10:00:00.000Z",
        verificationErrorCode: null,
        verificationFilePath: "/.well-known/aurora-tracker-verification.txt",
        verificationFileContent: "aurora-site-verification=abcdefghijklmnopqrstuvwxyzABCDEFG",
      },
    }))?.toMatchObject({ status: "paused" });
  });

  it("parses project templates without inventing missing fields", () => {
    expect(parseUtmTemplatesResponse({
      ok: true,
      templates: [{
        id: 7,
        name: "Telegram — банкротство",
        values: {
          utm_source: "telegram",
          utm_medium: "social",
          utm_campaign: "bankruptcy_august",
        },
        version: 3,
        updatedAt: "2026-08-11T10:00:00.000Z",
      }],
    }))?.toHaveLength(1);
    expect(parseUtmTemplatesResponse({
      ok: true,
      templates: [{ id: 7, name: "Broken", values: { utm_source: 42 }, version: 1, updatedAt: "now" }],
    })).toBeNull();
    expect(parseUtmTemplatesResponse({ ok: true, templates: [{ id: 7 }] })).toBeNull();
  });

  it("uses calm, actionable recovery copy", () => {
    expect(trackingSettingsErrorMessage("invalid_origin")).toContain("без пути");
    expect(trackingSettingsErrorMessage("invalid_utm")).toContain("без электронной почты и телефонов");
    expect(trackingSettingsErrorMessage("version_conflict")).toContain("Данные обновлены");
    expect(trackingSettingsErrorMessage("network")).toContain("Проверь подключение");
  });

  it("builds a copyable installation tag without accepting an unsafe key", () => {
    expect(trackingInstallSnippet(
      "https://aurora.example/app/settings",
      "tracker_public_key_1234567890",
    )).toBe(
      '<script src="https://aurora.example/api/tracking/client.js" data-project-key="tracker_public_key_1234567890"></script>',
    );
    expect(trackingInstallSnippet("https://aurora.example", 'bad" key')).toBeNull();
  });

  it("keeps forms semantic, labelled, project-aware and mobile-safe", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/components/app/tracking-settings-section.tsx"),
      "utf8",
    );
    expect(source).toContain("/api/tracking/settings");
    expect(source).toContain("/api/tracking/templates");
    expect(source).toContain("expectedVersion:");
    expect(source).toContain("currentProjectIdRef.current !== projectId");
    expect(source).toContain('<form noValidate');
    expect(source).toContain("<fieldset");
    expect(source).toContain("<legend");
    expect(source).toContain("<select");
    expect(source).toContain("aria-invalid=");
    expect(source).toContain("aria-describedby=");
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('role="status"');
    expect(source).toContain('role="alert"');
    expect(source).toContain("min-h-11");
    expect(source).toContain("text-base sm:text-");
    expect(source).toContain("break-words");
    expect(source).toContain("Домен не подтверждён");
    expect(source).toContain("/api/tracking/settings/verify");
    expect(source).toContain("Подтвердить домен");
    expect(source).toContain("не заменяет подтверждение домена");
    expect(source).toContain("Секретные ключи здесь не показываются");
    expect(source).toContain('parsed.status === "active"');
    expect(source.match(/variant="brand"/gu)).toHaveLength(1);
    expect(source).not.toContain("transition-all");
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(source).not.toContain("tracking.status = \"active\"");
  });

  it("is integrated once into the general project settings", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/app/app/settings/page.tsx"),
      "utf8",
    );
    expect(source.match(/import \{ TrackingSettingsSection \}/gu)).toHaveLength(1);
    expect(source.match(/<TrackingSettingsSection \/>/gu)).toHaveLength(1);
  });
});
