import assert from "node:assert/strict";

// Playwright 1.61.1 loses a binding received before context destruction because
// it looks up that context after awaiting page initialization. Capture the exact
// context at event arrival. Unknown-at-arrival contexts must remain unknown.
// This changes event delivery only; no release oracle or application is patched.
const original = "async _onBindingCalled(event) {\n        const pageOrError = await this._page.waitForInitializedOrError();\n        if (!(pageOrError instanceof Error)) {\n          const context2 = this._contextIdToContext.get(event.executionContextId);\n          if (context2)\n            await this._page.onBindingCalled(event.payload, context2);\n        }\n      }";
const corrected = "async _onBindingCalled(event) {\n        const context2 = this._contextIdToContext.get(event.executionContextId);\n        const pageOrError = await this._page.waitForInitializedOrError();\n        if (!(pageOrError instanceof Error)) {\n          if (context2)\n            await this._page.onBindingCalled(event.payload, context2);\n        }\n      }";
export function patchFirefoxBindingSource(source, version) {
  assert.equal(version, "1.61.1", "Review the Firefox workaround before changing Playwright");
  assert.equal(source.split(original).length, 2, "Expected the single reviewed upstream Firefox binding handler");
  return source.replace(original, corrected);
}
