# Aurora search and guide

The shared application header now opens search for sections, common actions and exact settings. A user can type “написать пост”, “запланировать публикацию” or “подключить канал”, read a short explanation and navigate to the destination. No search request reaches AI or application data.

The optional guide explains all 16 main navigation sections. Calendar, Studio, Autopilot and Settings have three-step walkthroughs. The guide highlights existing controls and explains missing/permission-dependent controls without executing actions. While help is open, navigation rows expose separate explanation buttons. Mobile navigation temporarily hides the guide. Closing a guide link clears only its guide parameter and does not remount page forms.

The release is based on e90a799 and preserves its project transport, authentication, media scope and existing settings code. Only the new files, shell integration and one settings search marker are included. Current production Studio supports images; help does not advertise video generation.

## Consolidated interface review — full

| Domain | Evidence | Result |
| --- | --- | --- |
| Accessibility | Native links/buttons, shared modal focus lifecycle, keyboard/shortcut/IME handling, focus return, nonmodal help, unsaved-setting guard | Clear |
| Layout | Previous implementation browser verification: five widths (320–1440), two themes; current shell integration compared with the verified implementation | Clear |
| Writing | 16 section descriptions, common actions, existing setting search catalog, fallback text; media copy updated to current release | Clear |
| Typography | Existing type tokens retained; mobile input 16px, labels and long descriptions wrap | Clear |
| Colors | Existing semantic tokens retained; measured search contrast in previous browser verification: minimum 5.40:1 light, 6.95:1 dark | Clear |
| UI | Explicit guide activation, collapse/reopen, page element outlines, no routine animation added | Clear |

No actionable interface findings remain in the changed scope. Found and fixed during implementation: form remounting on guide URL changes, guide overlap with mobile navigation, focus restoration after hint removal, and navigation with unsaved settings.

Considered but rejected: automatic first-login tours (help is optional); a separate color system (existing tokens already work); unrelated page layout and backend fixes (not required by this feature).

Local validation on the release checkout: 43 focused tests passed, ESLint clean, TypeScript clean. Fresh Chromium verification passed all 10 width/theme combinations, keyboard focus, menu explanation, collapse/reopen, empty results and navigation from search to settings and the Studio guide, with zero page errors. It ran against the release checkout's full dev runtime with an isolated local database; API fixtures include the current project endpoint and required project response header. The repeatable script is `scripts/test-discovery-browser.mjs`. CI and deployment validation provide separate release evidence.

Not verified: physical mobile keyboards, VoiceOver/NVDA, true browser zoom 200%, complete backend walkthrough actions. The guide itself does not execute backend actions.

Verdict: Approve for the reviewed component scope. Deployment remains conditional on the normal CI and production gates.
