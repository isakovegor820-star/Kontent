import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// Playwright 1.61.1 can deliver Page.bindingCalled after its execution context
// destruction event during Firefox reload. Retain that exact destroyed context
// briefly so the already-emitted binding reaches Node. A reused ID evicts the
// stale entry, and an ID unknown at event arrival remains unknown. This changes
// event delivery only; no release oracle or application is patched.
const reviewedHash = "6be5c2ea035554e9b184b1dbc7aa5e7f1fb428dd1b5c202022858dcfae9bee27";
const constructorOriginal = "this._contextIdToContext = /* @__PURE__ */ new Map();\n        this._browserContext = browserContext;";
const constructorCorrected = "this._contextIdToContext = /* @__PURE__ */ new Map();\n        this._destroyedContextIdToContext = /* @__PURE__ */ new Map();\n        this._browserContext = browserContext;";
const createdOriginal = "_onExecutionContextCreated(payload) {\n        const { executionContextId, auxData } = payload;";
const createdCorrected = "_onExecutionContextCreated(payload) {\n        const { executionContextId, auxData } = payload;\n        this._destroyedContextIdToContext.delete(executionContextId);";
const destroyedOriginal = "_onExecutionContextDestroyed(payload) {\n        const { executionContextId } = payload;\n        const context2 = this._contextIdToContext.get(executionContextId);\n        if (!context2)\n          return;\n        this._contextIdToContext.delete(executionContextId);\n        context2.frame.contextDestroyed(context2);\n      }";
const destroyedCorrected = "_onExecutionContextDestroyed(payload) {\n        const { executionContextId } = payload;\n        const context2 = this._contextIdToContext.get(executionContextId);\n        if (!context2)\n          return;\n        this._contextIdToContext.delete(executionContextId);\n        this._destroyedContextIdToContext.set(executionContextId, context2);\n        const expiry = setTimeout(() => {\n          if (this._destroyedContextIdToContext.get(executionContextId) === context2)\n            this._destroyedContextIdToContext.delete(executionContextId);\n        }, 5_000);\n        expiry.unref?.();\n        context2.frame.contextDestroyed(context2);\n      }";
const bindingOriginal = "async _onBindingCalled(event) {\n        const pageOrError = await this._page.waitForInitializedOrError();\n        if (!(pageOrError instanceof Error)) {\n          const context2 = this._contextIdToContext.get(event.executionContextId);\n          if (context2)\n            await this._page.onBindingCalled(event.payload, context2);\n        }\n      }";
const bindingCorrected = "async _onBindingCalled(event) {\n        const context2 = this._contextIdToContext.get(event.executionContextId) ?? this._destroyedContextIdToContext.get(event.executionContextId);\n        const pageOrError = await this._page.waitForInitializedOrError();\n        if (!(pageOrError instanceof Error)) {\n          if (context2)\n            await this._page.onBindingCalled(event.payload, context2);\n        }\n      }";
export function patchFirefoxBindingSource(source, version) {
  assert.equal(version, "1.61.1", "Review the Firefox workaround before changing Playwright");
  assert.equal(createHash("sha256").update(source).digest("hex"), reviewedHash,
    "Review the Firefox workaround against the exact Playwright bundle");
  for (const [original, label] of [[constructorOriginal, "constructor"], [createdOriginal, "creation"],
    [destroyedOriginal, "destruction"], [bindingOriginal, "binding"]]) {
    assert.equal(source.split(original).length, 2, `Expected the single reviewed upstream Firefox ${label} anchor`);
  }
  return source.replace(constructorOriginal, constructorCorrected)
    .replace(createdOriginal, createdCorrected)
    .replace(destroyedOriginal, destroyedCorrected)
    .replace(bindingOriginal, bindingCorrected);
}
