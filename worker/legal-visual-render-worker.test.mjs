import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { serializeLegalVisualConfig } from "../src/lib/legal-visual-model.mjs";
import { processLegalVisualRender } from "./legal-visual-render-worker.mjs";

function config(projectId = 17) {
  return {
    schemaVersion: 1,
    id: "visual-worker-test",
    projectId: String(projectId),
    revision: 2,
    name: "Памятка",
    format: "1:1",
    brand: {
      name: "Аврора",
      logo: null,
      colors: {
        background: "#f7f8fc",
        surface: "#ffffff",
        text: "#121827",
        mutedText: "#566074",
        accent: "#5b45e8",
        critical: "#c43a45",
      },
      allowedFonts: ["aurora-sans"],
      font: "aurora-sans",
      signature: "Аврора",
    },
    cards: [
      { id: "hook", order: 1, role: "hook", template: "key_number", eyebrow: "Главное", title: "Когда отвечать на претензию", theses: ["Сверьте условие договора"], emphasis: "", image: null, cta: null, sourceNote: "" },
      { id: "body", order: 2, role: "actions", template: "three_actions", eyebrow: "Практика", title: "Что проверить", theses: ["Найдите условие", "Назначьте ответственного", "Сохраните подтверждение"], emphasis: "", image: null, cta: null, sourceNote: "" },
      { id: "cta", order: 3, role: "cta", template: "question_answer", eyebrow: "Итог", title: "Следующий шаг", theses: ["Проверьте документы"], emphasis: "", image: null, cta: { label: "Сохранить", url: null }, sourceNote: "" },
    ],
  };
}

function operation(snapshot) {
  const hash = createHash("sha256").update(serializeLegalVisualConfig(snapshot)).digest("hex");
  return {
    id: 31,
    project_id: 17,
    design_id: 22,
    requested_by_user_id: 9,
    design_revision: 2,
    config_snapshot: snapshot,
    config_hash: hash,
    attempts: 1,
  };
}

describe("legal visual render worker", () => {
  it("renders every card and commits project-scoped media atomically", async () => {
    const row = operation(config());
    let assetId = 100;
    const tx = {
      query: vi.fn(async (sql) => {
        const text = String(sql);
        if (text.includes("update legal_visual_render_operations") && text.includes("returning id, project_id")) {
          return { rows: [row], rowCount: 1 };
        }
        if (text.includes("select status, config_hash")) return { rows: [{ status: "rendering", config_hash: row.config_hash }] };
        if (text.includes("insert into media_assets")) return { rows: [{ id: ++assetId }] };
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(),
      connect: vi.fn(async () => tx),
    };

    const result = await processLegalVisualRender({
      pool,
      data: { operationId: row.id, projectId: row.project_id, configHash: row.config_hash },
    });

    expect(result).toMatchObject({ duplicate: false, cards: 3, configHash: row.config_hash });
    const mediaWrites = tx.query.mock.calls.filter(([sql]) => String(sql).includes("insert into media_assets"));
    expect(mediaWrites).toHaveLength(3);
    expect(mediaWrites.every(([, params]) => params[1] === 17)).toBe(true);
    expect(tx.query.mock.calls.some(([sql]) => String(sql).includes("insert into legal_visual_render_cards"))).toBe(true);
    expect(tx.query.mock.calls.some(([sql]) => String(sql).includes("insert into legal_visual_render_attempts"))).toBe(true);
    expect(tx.query.mock.calls.some(([sql, params]) =>
      String(sql).includes("update legal_visual_render_attempts") && params?.[2] === 1
    )).toBe(true);
    expect(tx.query.mock.calls.some(([sql]) => String(sql).includes("set status = 'ready'"))).toBe(true);
    expect(tx.query).toHaveBeenCalledWith("commit");
    expect(tx.release).toHaveBeenCalledTimes(2);
  }, 30_000);

  it("fails closed when the persisted snapshot belongs to another project", async () => {
    const row = operation(config(99));
    const tx = {
      query: vi.fn(async (sql) => {
        const text = String(sql);
        if (text.includes("update legal_visual_render_operations") && text.includes("returning id, project_id")) {
          return { rows: [row], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(),
      connect: vi.fn(async () => tx),
    };

    const result = await processLegalVisualRender({
      pool,
      data: { operationId: row.id, projectId: row.project_id, configHash: row.config_hash },
    });

    expect(result).toEqual({ failed: true, errorCode: "render_project_mismatch" });
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(tx.query.mock.calls.some(([sql, params]) =>
      String(sql).includes("update legal_visual_render_operations") && params?.[1] === 17
    )).toBe(true);
    expect(tx.query.mock.calls.some(([sql, params]) =>
      String(sql).includes("update legal_visual_render_attempts")
      && params?.[3] === "failed"
      && params?.[4] === "render_project_mismatch"
    )).toBe(true);
  });
});
