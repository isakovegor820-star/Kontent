# Today pulse order — interface review

## Scope and Coverage

Quick review of section order in Today only. Next.js, Tailwind and existing Aurora components. Channel selection → pulse → metrics → publication queue → recommendations → completed decisions. Existing quick-mode visibility retained.

| Domain | Evidence inspected | Result |
| --- | --- | --- |
| Accessibility | DOM reading order, section headings, native statistics disclosure, Tab into graph link | Clear |
| Layout | Rendered 1280 px and 390 px widths; pulse precedes queue and recommendations | Fixed |
| Writing | Existing pulse states and section labels in their new context | Clear |
| Typography | Existing heading hierarchy, mobile text wrapping | Clear |
| Colors | Existing semantic tokens and dark-theme rendering; no token changes | Clear within reorder scope |
| UI | Existing cards, disclosure and refresh controls | Clear |

## Findings

| # | Severity | Domain | Location | Before | After | Why |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | MEDIUM | Layout | src/app/app/today/page.tsx | Pulse followed recommendations and completed items | Pulse and metrics directly follow channel controls | Channel state is visible before choosing work |

## Considered but Rejected

| Location | Candidate | Rejected because |
| --- | --- | --- |
| Today content wrapper | CSS order utilities | Moving JSX also aligns keyboard and screen-reader order |
| ChannelPulse | New visual styling or copy | Existing component already communicates status; request concerns position |

## Verification

- Existing page/publication tests: 18 passed.
- Existing isolated PostgreSQL integrations: 6 passed.
- ESLint, TypeScript and diff check passed.
- Full local web + worker runtime on fresh isolated database.
- Browser 1280 px: pulse precedes publication queue, recommendations and completed items; document width 1270 px.
- Browser 390×844: same order; document width 380 px, no horizontal overflow.
- Statistics disclosure opens; Tab reaches “Открыть все графики”.
- Not verified: screen-reader application, new light-theme/contrast audit. No colors or typography changed.

## Verdict

Approve
