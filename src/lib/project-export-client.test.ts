import { describe, expect, it, vi } from "vitest";

import {
  createProjectExport,
  defaultProjectExportPeriod,
  downloadProjectExport,
  parseProjectExportPreview,
  parseExportAuthorOptions,
  parseExportCampaignOptions,
  parseProjectExportOperation,
  projectExportRequestBody,
  previewProjectExport,
  validateProjectExportPeriod,
  type ClientProjectExportOperation,
  type ProjectExportFormValue,
} from "./project-export-client";

const operation: ClientProjectExportOperation = {
  id: 41,
  kind: "content_plan",
  format: "xlsx",
  status: "ready",
  filters: {
    period: { from: "2026-08-01", to: "2026-08-31" },
    channel: ["ТехнологИИ Права"],
    author: ["Ирина"],
    campaign: ["Практика банкротства"],
    status: ["Запланирован"],
  },
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-08-11T10:00:00.000Z",
  updatedAt: "2026-08-11T10:00:01.000Z",
  completedAt: "2026-08-11T10:00:01.000Z",
  artifact: {
    byteSize: 2048,
    fileName: "ТехнологИИ-Права-контент-план-2026-08.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    expiresAt: "2026-08-12T10:00:01.000Z",
  },
};

const form: ProjectExportFormValue = {
  kind: "content_plan",
  format: "xlsx",
  from: "2026-08-01",
  to: "2026-08-31",
  channel: "ТехнологИИ Права",
  author: "Ирина",
  campaign: "Практика банкротства",
  status: "Запланирован",
};

function json(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

describe("project export browser contract", () => {
  it("accepts only a complete server operation and never accepts ready without an artifact", () => {
    expect(parseProjectExportOperation(operation)).toEqual(operation);
    expect(parseProjectExportOperation({ ...operation, artifact: null })).toBeNull();
    expect(parseProjectExportOperation({ ...operation, status: "completed-ish" })).toBeNull();
    expect(parseProjectExportOperation({ ...operation, filters: { period: {} } })).toBeNull();
  });

  it("builds a project-free request with all supported filters", () => {
    const payload = projectExportRequestBody(form);
    expect(payload).toEqual({
      kind: "content_plan",
      format: "xlsx",
      period: { from: "2026-08-01", to: "2026-08-31" },
      filters: {
        channel: ["ТехнологИИ Права"],
        author: ["Ирина"],
        campaign: ["Практика банкротства"],
        status: ["Запланирован"],
      },
    });
    expect(JSON.stringify(payload)).not.toMatch(/project_?id/iu);
  });

  it("sends the immutable request key separately and trusts only the returned operation", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(json({ ok: true, operation }));
    await expect(createProjectExport(
      form,
      "export-client-001",
      "a".repeat(64),
      undefined,
      fetcher,
    )).resolves.toEqual(operation);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/project-exports");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["idempotency-key"]).toBe("export-client-001");
    expect(String(init?.body)).not.toMatch(/project_?id/iu);
    expect(JSON.parse(String(init?.body))).toMatchObject({ previewHash: "a".repeat(64) });
  });

  it("accepts a strict server-backed count and sample before creation", async () => {
    const preview = {
      kind: "content_plan",
      timezone: "Europe/Amsterdam",
      period: { from: "2026-08-01", to: "2026-08-31" },
      filters: {
        channel: ["ТехнологИИ Права"],
        author: ["Ирина"],
        campaign: ["Практика банкротства"],
        status: ["Запланирован"],
      },
      rowCount: 1,
      exceedsLimit: false,
      previewHash: "b".repeat(64),
      sample: [{
        id: "51",
        occurredAt: "2026-08-11T10:00:00.000Z",
        channel: "ТехнологИИ Права",
        title: "Тема кампании",
        status: "Запланирован",
        author: "Ирина",
        campaign: "Практика банкротства",
      }],
    };
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(json({ ok: true, preview }));
    await expect(previewProjectExport(form, undefined, fetcher)).resolves.toEqual(preview);
    expect(fetcher).toHaveBeenCalledWith("/api/project-exports/preview", expect.objectContaining({
      method: "POST",
    }));
    expect(parseProjectExportPreview({ ok: true, preview: { ...preview, sample: [{ title: "missing fields" }] } })).toBeNull();
    expect(parseProjectExportPreview({ ok: true, preview: { ...preview, timezone: "Invalid/Timezone" } })).toBeNull();
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).not.toHaveProperty("previewHash");
  });

  it("keeps the short-lived download token out of the URL and sends it only as a header", async () => {
    const token = "A".repeat(43);
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(json({
        ok: true,
        token,
        expiresAt: "2026-08-11T10:15:00.000Z",
        downloadUrl: "/api/project-exports/41/download",
        tokenHeader: "x-export-download-token",
      }))
      .mockResolvedValueOnce(new Response(new Blob(["данные"]), {
        status: 200,
        headers: { "content-type": operation.artifact?.mimeType ?? "application/octet-stream" },
      }));

    const file = await downloadProjectExport(operation, undefined, fetcher);
    expect(file.fileName).toBe(operation.artifact?.fileName);
    expect(await file.blob.text()).toBe("данные");
    expect(fetcher.mock.calls[0][0]).toBe("/api/project-exports/41/download-token");
    expect(fetcher.mock.calls[1][0]).toBe("/api/project-exports/41/download");
    expect(fetcher.mock.calls[1][0]).not.toContain(token);
    expect(fetcher.mock.calls[1][1]?.headers).toEqual({ "x-export-download-token": token });
  });

  it("validates ordering and the 366-day limit before a request", () => {
    expect(validateProjectExportPeriod({ from: "2026-08-31", to: "2026-08-01" })).toContain("не раньше");
    expect(validateProjectExportPeriod({ from: "2025-01-01", to: "2026-01-02" })).toContain("366");
    expect(validateProjectExportPeriod({ from: "2026-01-01", to: "2026-12-31" })).toBeNull();
    expect(defaultProjectExportPeriod("analytics", new Date(2026, 7, 11))).toEqual({
      from: "2026-07-13",
      to: "2026-08-11",
    });
  });

  it("offers only real member names and campaign goals returned by project-scoped endpoints", () => {
    expect(parseExportAuthorOptions({
      ok: true,
      members: [{ name: "Ирина" }, { name: null }, { name: "ирина" }, { name: "Олег" }],
    })).toEqual([
      { value: "Ирина", label: "Ирина" },
      { value: "Олег", label: "Олег" },
    ]);
    expect(parseExportCampaignOptions({
      ok: true,
      campaigns: [{ goal: "Практика банкротства" }, { goal: "Практика банкротства" }],
    })).toEqual([{ value: "Практика банкротства", label: "Практика банкротства" }]);
    expect(parseExportCampaignOptions({ ok: true, campaigns: [{ title: "Выдуманная" }] })).toBeNull();
  });
});
