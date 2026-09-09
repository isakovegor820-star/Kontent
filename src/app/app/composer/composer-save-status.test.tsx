// @vitest-environment jsdom
import React, { useState } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

const source = readFileSync(process.env.N45_COMPOSER_SOURCE || resolve("src/app/app/composer/page.tsx"), "utf8");
const tree = ts.createSourceFile("composer.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let section: ts.FunctionDeclaration | undefined;
let summary: ts.Expression | undefined;
let footer: ts.JsxElement | undefined;
let scheduledFooter: ts.JsxElement | undefined;
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "EditorSection") section = node;
  if (ts.isJsxOpeningElement(node) && node.tagName.getText(tree) === "EditorSection"
    && node.attributes.properties.some((attribute) => ts.isJsxAttribute(attribute)
      && attribute.name.getText(tree) === "id" && attribute.initializer?.getText(tree) === '"composer-protection"')) {
    const attribute = node.attributes.properties.find((item) => ts.isJsxAttribute(item) && item.name.getText(tree) === "summary");
    if (attribute && ts.isJsxAttribute(attribute) && attribute.initializer && ts.isJsxExpression(attribute.initializer)) summary = attribute.initializer.expression;
  }
  if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some((attribute) =>
    ts.isJsxAttribute(attribute) && attribute.name.getText(tree) === "aria-live")
    && node.getText(tree).includes('approved ? "Готово к публикации"')
    && node.getText(tree).includes("c.draftSaveState")) footer = node;
  if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some((attribute) =>
    ts.isJsxAttribute(attribute) && attribute.name.getText(tree) === "aria-live")
    && node.getText(tree).includes("activeSettled") && node.getText(tree).includes("c.draftSaveState")) scheduledFooter = node;
  ts.forEachChild(node, visit);
}
visit(tree);
if (!section || !summary || !footer || !scheduledFooter) throw new Error("Actual Composer save summary/footer unavailable");
afterEach(cleanup);

function show(draftSaveState: string, scheduled = false) {
  const bindings = { React, useState, ChevronDown, cn, approved: false, activeSettled: false, deliveryPresentation: null,
    fmtDateTime: () => "06.09.2026 12:30", fmtTime: () => "12:30",
    c: { draftSaveState, draftSavedAt: 1, activePublication: { status: "queued", scheduledAt: "2026-09-06T12:30:00Z", timezone: "UTC" } } };
  const evaluate = (code: string) => new Function(...Object.keys(bindings), ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText)(...Object.values(bindings));
  const EditorSection = evaluate(section!.getText(tree) + "; return EditorSection;") as React.ComponentType<{
    id: string; title: string; summary: string; icon: React.ReactNode; children: React.ReactNode;
  }>;
  render(<>
    <EditorSection id="composer-protection" title="Сохранение и версии" summary={evaluate("return (" + summary!.getText(tree) + ");")} icon={null}>
      <p>Подробности сохранения</p>
    </EditorSection>
    {evaluate("return (" + (scheduled ? scheduledFooter! : footer!).getText(tree) + ");") as React.ReactNode}
  </>);
  return {
    details: document.querySelector<HTMLDetailsElement>("#composer-protection")!,
    summary: document.querySelector("#composer-protection > summary")!,
    footer: document.querySelector('[aria-live="polite"]')!,
  };
}

it.each([false, true])("exposes a server save failure in the default collapsed summary and live footer (scheduled=%s)", (scheduled) => {
  const ui = show("failed", scheduled);
  expect(ui.details.open).toBe(false);
  expect(ui.summary.textContent).toContain("Ошибка сохранения");
  expect(ui.footer.textContent).toContain("Не удалось сохранить на сервере");
  expect(ui.footer.closest("details")).toBeNull();
  expect(screen.queryByText("Автосохранение включено")).toBeNull();
  expect(screen.queryByText("Изменения сохраняются автоматически")).toBeNull();
  expect(ui.footer.textContent).not.toContain("сохраняем изменения");
});

it.each([
  ["saving", "Сохраняем на сервере…", "Сохраняем изменения…"],
  ["saved", "Сохранено в 12:30", "Сохранено в 12:30"],
  ["offline", "Защищено локально · ждём сеть", "Нет сети — изменения защищены локальной копией"],
  ["idle", "Автосохранение включено", "Изменения сохраняются автоматически"],
])("retains the existing %s save indication", (state, summaryText, footerText) => {
  const ui = show(state);
  expect(ui.details.open).toBe(false);
  expect(ui.summary.textContent).toContain(summaryText);
  expect(ui.footer.textContent).toContain(footerText);
});

it.each([
  ["saving", "Сохраняем на сервере…", "сохраняем изменения"],
  ["saved", "Сохранено в 12:30", "изменения сохранены"],
])("retains the scheduled publication's %s save indication", (state, summaryText, footerText) => {
  const ui = show(state, true);
  expect(ui.details.open).toBe(false);
  expect(ui.summary.textContent).toContain(summaryText);
  expect(ui.footer.textContent).toContain("06.09.2026 12:30");
  expect(ui.footer.textContent).toContain(footerText);
});
