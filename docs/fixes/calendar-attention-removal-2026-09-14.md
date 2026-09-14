# Calendar attention section removal

## Scope and Coverage

Quick interface review of removing the all-date attention list from the calendar. Stack: Next.js, React, Tailwind and existing Card/Badge/Button components. Evidence: supplied screenshot and `src/app/app/calendar/page.tsx`. Coverage is limited to this removal and adjacent sections; no claim of live browser validation.

| Domain | Evidence inspected | Result |
| --- | --- | --- |
| Accessibility | Removed section has no remaining label references; existing card names and keyboard controls retained | Clear for removal |
| Layout | Screenshot's long warning list; removed section and its conditional wrapper before additional materials | One issue fixed |
| Writing | Old Open button calls openPost, which only shows a status toast for records without a linked draft | Removed misleading entry point |
| Typography | Existing adjacent heading and card classes unchanged | Clear for removal |
| Colors | Existing status badges and semantic tokens remain on publication cards | Clear for removal |
| UI | Removed repeated buttons; no new controls, motion or styling | Clear for removal |

## Findings

| # | Severity | Domain | Location | Before | After | Why |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | MEDIUM | Layout | `src/app/app/calendar/page.tsx:2613` (section boundary after removal) | All-date warnings occupy a large section, including old records whose Open action just repeats their status | Remove section and unused attentionPosts calculation | Keeps the calendar focused on the selected dates and avoids repeated dead-end actions |

The finding is resolved. No actionable interface findings remain within the removal scope.

## Considered but Rejected

| Location | Candidate | Rejected because |
| --- | --- | --- |
| `src/app/app/calendar/page.tsx:708` | Hide warning statuses on publication cards too | Status remains useful beside the actual publication; the request concerns the separate section |
| `src/app/app/calendar/page.tsx:2613` | Replace the list with a collapsed warning panel | Adds another control and retains the redundant all-date list the user wants removed |

## Verification

- `npx vitest run src/app/app/calendar/page.test.ts src/lib/calendar-records.test.ts src/lib/calendar-team-filters.test.ts`: 23 tests passed.
- `npx eslint src/app/app/calendar/page.tsx`: passed.
- `npx tsc --noEmit --incremental false`: passed. The repository has no `typecheck` npm script, so the compiler was run directly.
- `git diff --check`: passed.
- Diff inspection: only the standalone section and its unused derived list were removed; publication data, status rendering and retry actions are retained.
- **Not verified**: rendered updated page, mobile/zoom and screen-reader behavior. No runtime visual changes beyond section removal are claimed.
- Publication to the live site has not been performed.

## Verdict

Approve — no actionable findings remain within the verified source-level removal scope.
