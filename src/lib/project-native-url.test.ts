import { afterEach, describe, expect, it } from "vitest";
import { setClientProjectId } from "./project-fetch";
import { mediaAssetUrl, projectNativeUrl } from "./project-native-url";

afterEach(() => setClientProjectId(null));
describe("native tab project URLs", () => {
  it("binds legacy media and preserves download/format parameters", () => {
    setClientProjectId(23);
    expect(projectNativeUrl("/api/media/assets/41?download=1")).toBe("/api/media/assets/41?download=1&projectId=23");
    expect(projectNativeUrl("/api/sites/2/reports/9/export?format=pdf")).toBe("/api/sites/2/reports/9/export?format=pdf&projectId=23");
    expect(projectNativeUrl("/api/legal-video-scripts/9/production-brief")).toBe("/api/legal-video-scripts/9/production-brief?projectId=23");
    expect(mediaAssetUrl(41, 3)).toBe("/api/media/assets/41?projectId=3");
  });
  it("rebinds native presentation to this tab after a project switch and fails closed before hydration", () => {
    expect(projectNativeUrl("/api/media/assets/41?projectId=7")).toBe("/api/media/assets/41?projectId=0");
    setClientProjectId(23);
    expect(projectNativeUrl("/api/media/assets/41?projectId=7")).toBe("/api/media/assets/41?projectId=23");
  });
  it("does not attach project IDs to external URLs or account-owned avatars", () => {
    setClientProjectId(23);
    for (const url of ["https://example.test/a.png", "//example.test/api/media/assets/41", "/api/settings/profile/avatar-assets/41", "blob:http://localhost/a"]) expect(projectNativeUrl(url)).toBe(url);
  });
  it("binds OAuth full navigation to the initiating tab project", () => {
    setClientProjectId(23);
    expect(projectNativeUrl("/api/channels/oauth/start?network=youtube")).toBe("/api/channels/oauth/start?network=youtube&projectId=23");
  });
});
