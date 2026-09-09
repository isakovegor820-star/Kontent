// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as lifecycle from "@/lib/publication-lifecycle-client";
import { Badge } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Bookmark, CalendarClock } from "lucide-react";
import { cn } from "@/lib/utils";

const source = readFileSync(process.env.N44_COMPOSER_SOURCE || resolve("src/app/app/composer/page.tsx"), "utf8");
const tree = ts.createSourceFile("composer.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let header: ts.JsxElement | undefined;
let footer: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some((attribute) =>
    ts.isJsxAttribute(attribute) && attribute.name.getText(tree) === "role" && attribute.initializer?.getText(tree) === '"status"')
    && node.getText(tree).includes("c.activePublicationLoading") && node.getText(tree).includes("<Badge")) header = node;
  if (ts.isConditionalExpression(node) && node.condition.getText(tree) === "c.activePublication" && node.whenTrue.getText(tree).includes("cloneActivePublication")) footer = node.whenTrue;
  ts.forEachChild(node, visit);
}
visit(tree);
if (!header || !footer) throw new Error("Actual Composer publication header/footer unavailable");

afterEach(cleanup);
function publication(statuses: string[]): lifecycle.PublicationOperationEditorContext {
  return { operationId: 7, draftId: 41, draftVersion: 3, status: "queued", scheduledAt: "2026-09-05T10:00:00Z", timezone: "UTC", scheduleRevision: 1,
    scheduleOffset: "+00:00", scheduleDisambiguation: "reject", destinations: statuses.map((postStatus, index) => ({ postId: index + 1, postStatus })) };
}
function show(statuses: string[]) {
  const operation = publication(statuses);
  const presentation = typeof lifecycle.publicationDeliveryPresentation === "function" ? lifecycle.publicationDeliveryPresentation(operation) : null;
  const bindings = { React, ...lifecycle, Badge, Button, Bookmark, CalendarClock, cn, fmtDateTime: () => "05.09.2026 10:00", approved: true, unavailable: false,
    activeSettled: lifecycle.publicationOperationIsSettled(operation), deliveryPresentation: presentation,
    c: { activePublication: operation, activePublicationLoading: false, activePublicationError: "", cloneActivePublication: () => {}, saving: false } };
  const evaluate = (expression: ts.Node) => {
    const code = ts.transpileModule("return (" + expression.getText(tree) + ");", { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
    return new Function(...Object.keys(bindings), code)(...Object.values(bindings)) as React.ReactNode;
  };
  render(<>{evaluate(header!)}{evaluate(footer!)}</>);
  return operation;
}

it.each([
  { statuses: ["published_unverified"], label: "Ждёт подтверждения", phrase: "Доставка не подтверждена" },
  { statuses: ["missing"], label: "Не найдено во внешней сети", phrase: "Публикация не найдена" },
  { statuses: ["deleted_external"], label: "Удалено во внешней сети", phrase: "Публикация удалена во внешней сети" },
  { statuses: ["published", "published_unverified"], label: "Ждёт подтверждения", phrase: "Доставка не подтверждена" },
  { statuses: ["published", "failed"], label: "Опубликовано частично", phrase: "Опубликовано не во всех назначениях" },
])("does not present $statuses as confirmed publication success", ({ statuses, label, phrase }) => {
  const operation = show(statuses);
  expect(screen.queryByText("Опубликовано", { exact: true })).toBeNull();
  expect(screen.getByText(label, { exact: true })).toBeTruthy();
  expect(screen.getByText(phrase, { exact: true })).toBeTruthy();
  expect(document.body.textContent).not.toContain("Публикация уже завершена");
  expect(document.body.textContent).not.toContain("Публикация завершена.");
  expect(lifecycle.publicationEditorMutationKind(operation, 41, 3)).toBe("clone_required");
  expect(screen.getByRole("button", { name: "Создать новый пост" })).toBeTruthy();
});

it("retains confirmed success only when every destination is published", () => {
  show(["published", "published"]);
  expect(screen.getByText("Опубликовано", { exact: true })).toBeTruthy();
  expect(screen.getByText("Публикация уже завершена", { exact: true })).toBeTruthy();
});
