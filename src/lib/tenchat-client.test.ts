import { describe, expect, it } from "vitest";

import { tenChatDownloadFileName, tenChatExportFailure } from "./tenchat-client";

describe("TenChat client error mapping", () => {
  it("never describes an export failure as a live publication failure", () => {
    expect(tenChatExportFailure("server")).toEqual({
      title: "Не удалось подготовить пакет",
      body: expect.stringContaining("в TenChat ничего не отправлялось"),
    });
  });

  it("decodes an RFC 5987 download name and falls back safely", () => {
    expect(tenChatDownloadFileName(
      "attachment; filename=project.zip; filename*=UTF-8''%D0%9F%D1%80%D0%BE%D0%B5%D0%BA%D1%82.zip",
    )).toBe("Проект.zip");
    expect(tenChatDownloadFileName("attachment")).toBe("aurora-tenchat-package.zip");
  });
});
