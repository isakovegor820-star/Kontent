# Aurora Main Reasons Route Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the old reasons ledger on `/` with the approved Variant 2 live-route section while keeping all comparison controls off the production page.

**Architecture:** Reuse the existing `ReasonsVariants` dispatcher through `VariantLanding.reasonsVariant`; do not duplicate Variant Two. Add a production-safe `showReasonsSwitcher` flag that defaults to `false`, enable it only on `/reasons/1..3`, and load the existing reasons stylesheet from the production page.

**Tech Stack:** Next.js 16 App Router, React 19 Server/Client Components, TypeScript, Vitest, global CSS.

## Global Constraints

- Preserve all existing copy, business logic, routes, hero variant 4, and data in `REASON_ROWS`.
- Do not expose `VariantSwitcher` or `ReasonsSwitcher` on `/`.
- Do not duplicate the approved reasons component or its CSS.
- Preserve the three `/reasons/*` comparison pages and their switcher.
- Work in the existing shared dirty checkout because the approved files are untracked there; do not create commits or rewrite unrelated changes.

---

### Task 1: Install approved reasons section on production landing

**Files:**
- Create: `src/app/page.test.ts`
- Modify: `src/app/page.tsx:1-24`
- Modify: `src/components/v3/variants/landing.tsx:347-363`
- Modify: `src/app/reasons/1/page.tsx:1-5`
- Modify: `src/app/reasons/2/page.tsx:1-5`
- Modify: `src/app/reasons/3/page.tsx:1-5`

**Interfaces:**
- Consumes: `ReasonsVariants({ variant: 2 })` through `VariantLanding({ reasonsVariant: 2 })`.
- Produces: `VariantLanding.showReasonsSwitcher?: boolean`, defaulting to `false`.

- [x] **Step 1: Write the failing production render test**

```ts
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import LandingPage from "./page";

describe("production landing page", () => {
  it("renders the approved reasons route without comparison controls", () => {
    const markup = renderToStaticMarkup(createElement(LandingPage));

    expect(markup).toContain('class="rv rv2"');
    expect(markup.match(/data-route-action=/g)).toHaveLength(3);
    expect(markup).not.toContain('id="v3-ledger-title"');
    expect(markup).not.toContain('class="rv-switcher"');
    expect(markup).not.toContain('class="av-switcher"');
  });
});
```

- [x] **Step 2: Run the test and verify RED**

Run: `npm test -- src/app/page.test.ts`

Expected: FAIL because `/` still renders `V3Ledger` and does not contain `.rv2`.

- [x] **Step 3: Add production-safe switcher control**

Update `VariantLanding`:

```tsx
export function VariantLanding({
  variant,
  showSwitcher = true,
  reasonsVariant,
  showReasonsSwitcher = false,
}: {
  variant: Variant;
  showSwitcher?: boolean;
  reasonsVariant?: ReasonsVariant;
  showReasonsSwitcher?: boolean;
}) {
  return (
    <div className={`aurora-variants aurora-variant-${variant}`}>
      <div className="v3-grain" aria-hidden />
      {showSwitcher && <VariantSwitcher active={variant} />}
      {reasonsVariant && showReasonsSwitcher && (
        <ReasonsSwitcher active={reasonsVariant} />
      )}
```

- [x] **Step 4: Enable Variant 2 and its stylesheet on `/`**

Update `src/app/page.tsx`:

```tsx
import "./reasons/reasons.css";

<VariantLanding
  variant={4}
  showSwitcher={false}
  reasonsVariant={2}
  showReasonsSwitcher={false}
/>
```

- [x] **Step 5: Keep comparison navigation on preview routes**

Use this pattern in `/reasons/1`, `/reasons/2`, and `/reasons/3`:

```tsx
return (
  <VariantLanding
    variant={4}
    showSwitcher={false}
    reasonsVariant={2}
    showReasonsSwitcher
  />
);
```

Each page keeps its own existing `reasonsVariant` value.

- [x] **Step 6: Run the focused test and verify GREEN**

Run: `npm test -- src/app/page.test.ts src/components/v3/reasons-variants.test.ts`

Expected: both files pass.

- [x] **Step 7: Verify production behavior**

Run:

```bash
npm test
npm run lint
npm run build
```

Browser checks:

- `/` renders `.rv2` with three routes and no `.rv-switcher` or `.av-switcher`.
- `/reasons/2` still renders `.rv-switcher`.
- At 390px and 1440px the production reasons section has no internal horizontal overflow.
