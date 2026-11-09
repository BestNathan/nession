# Session operation surfaces · Web/App — interactive prototype (#3089)

**Owning Requirement:** https://github.com/BestNathan/nession/issues/3089

**Separate owners:** #3025 (Project-aware Session creation: accepted domain behavior), #3082 (Session→Project binding), #2875 (App Sessions actions), #3075 (Web rail). This mock only studies **presentation of existing operations**. Previous #3025 prototype remains valuable for Project semantics, but its narrow Create Session dialog presentation is **superseded** by the candidate in #3089.

## Product baseline and source

- Reviewed VISION.md, PRINCIPLE.md, docs/design/interaction/{app,web}.md, docs/design/design-system/{components,patterns}.md.
- Existing product owners inspected on staging 2026-11-09: web/src/components/ui/dialog.tsx (384px shared default); web/src/product/session/components/{AttachDialog,CreateSessionDialog}.tsx; web/src/product/project/components/{ProjectDialogs,ProjectLocationsEditor}.tsx; web/src/app/patterns/AppProjectDetail.tsx; web/src/app/experiences/app/AppLayout.tsx.
- Project UI is authoritative on staging, not yet on main. Design palette in styles.css is a local snapshot of named Nession values from design/generated/web.css, not a competing design token owner.
- The review harness uses shared sibling prototype-frame-2758/frame.css and frame.js, with real CSS-pixel widths and external fixtures. All product screen content belongs inside the simulated viewport.

### IA current ownership / candidate delta

**Web:** WebLayout → Sidebar (flat Sessions, Projects) + main ProjectDetail / Terminal → shared Dialog portal (Attach / Create Session / Project settings). Candidate: content-aware wide dialogs and readable Agent/path/address rows; no new shell navigation.

**App:** AppLayout/AppLayers → Sessions layer → ProjectDetail (one host AppPageHeader), or current Terminal → operation depth for Attach/Create Session/Project maintenance with one visible header and Back. Candidate: quick Attach sheet, full operation page, child Location/ENV selectors. The underlying Session and Terminal remain conceptually mounted. The prototype's CSS overlays are not production mount proof.

**Fidelity status:** structure source-reviewed; React fixture screenshot and full DOM parity have NOT been independently proven. Do not claim production visual fidelity based on this mock.

## Decisions and interactive paths

- **Web Attach:** Sidebar Session menu → Attach → roomy responsive 720px dialog; Auto/P2P/Relay side by side, whole candidate addresses, Copy full address, simulated Re-test, Cancel / Attach. Session actions → Attach settings saves preferences without attaching.
- **App Attach:** App Sessions → Session actions → Attach → compact bottom sheet. Connection settings opens full-height screen. Select mode, Use this mode returns to quick sheet without attaching, explicit Attach confirms. Direct Attach settings opens the configuration page and Save only changes preference.
- **Web Create:** Project detail → New Session → responsive 640px dialog; **open a content-sized Existing Location dropdown**, select Agent+directory (distinct lines plus online/offline status), confirm the closed trigger retains all visible lines and the option list wraps long paths within the same anchored width; ENV summary/options and submit remain unchanged. Ordinary New Session stays unbound to Project.
- **App Create:** Project detail → New Session → full-height operation page, child Location and ENV selectors, Back preserving draft, explicit Create opens new Session. Cancel preserves original Project context. Project Create/Settings uses full-height views and stacked Agent/Directory editor.
- **Scenarios:** Very long paths and URLs, offline Agent, multiple locations, ENV options, cancellation and return to the same navigation context.
- **Devices:** Web 1440/1180/1024 and App 375/390/430/844×390. The product composition changes with review size; there is no zoom or CSS scale.

## Walkthrough

1. Start on Web Project detail. New Session → choose Agent/location and ENV → Create. The mock changes to the selected Terminal.
2. Session sidebar ··· → Attach → compare modes and candidate addresses, Re-test and Attach or cancel.
3. Reset → App 390. Sessions ··· → Attach → Connection settings → P2P → Use this mode → quick sheet → Attach.
4. Reset App 390 → Project → New Session → Location child → select Test Agent → Back → ENV child → select → Back → Create. Check draft preservation.
5. Session ··· → Attach settings → Save settings returns without attaching. Project Settings → modify Project/locations → Save changes.
6. Activate Very long path/address and Agent offline fixtures. Check readable text/error/disabled state.
7. Web 1180 → App 375 → Web 1180; after each change inspect the actual viewport layout, not just its frame. Reset to restart.

## Fidelity / verification

- **Mock:** Project/Agent/Session state, attachment, probe/latency, Session terminal, environment selection, saving and errors. These are deterministic local browser variables.
- **No network or secrets:** no Server API, tmux, provider, WebSocket, Project backend mutation, private data, real addresses or user files. Examples use .example.test and fictional paths.
- **Static / synthetic checks (2026-11-09):** standalone JS parsed successfully in V8; source references and structured frame anchors verified. A minimal in-memory DOM/event stub exercised Web create, explicit configure/Save, App quick Attach → advanced mode → quick sheet → explicit Attach, App Project Create Session → Location/ENV child → Back → Create, and Project Create entry. This is a **synthetic source check**, not Chromium or a real rendered-page assertion.
- **Browser verification:** **Pending** Chromium+Playwright at this new SHA for trigger/option DOM box geometry, long-path wrapping and no horizontal overflow; the existing broader Web/App scenarios have prior historical evidence but must be rechecked for this revision.
- **Pages publication:** the public Pages publisher is the authority for exact source SHA and artifact bytes. See the owning Issue for the latest verified Run/SHA; do not infer latest live content solely from a prototype branch push. A verified gallery/manifest does not alone establish that this page was clicked through in Chromium.
- **Production Acceptance:** #3089's original SC-01…SC-06 have historical accepted receipts; the reopened geometry regression SC-07 and revised publication SC-08 are **Pending** until independent authenticated verification. A prototype cannot prove the production Select behavior.
- **Evidence authority:** independent published Pages readback + immutable commit identifies mock revision; mock success does not demonstrate actual Session creation.

## Links

- Preview (not yet deployment-verified): https://bestnathan.github.io/nession/prototypes/session-operation-surfaces-3089/index.html
- Pages gallery: https://bestnathan.github.io/nession/#/prototypes
- Mutable source: https://github.com/BestNathan/nession/tree/prototype/session-operation-surfaces-3089
- Immutable source: use the source SHA recorded in the owning Issue and the trusted public Pages manifest.

## Non-goals

No production React code, no new backend endpoint, no changes to domain semantics, no Managed EROFS path (#3062), no Session→Project binding (#3082), no physical iPhone/Safari proof.

## Post-acceptance correction — 2026-11-09: content-sized Location Select

**Feedback:** In Project → New Session, the content is visually taller/wider than its Select border/menu. The original candidate depicted selectable cards on Web, so it could not reveal the underlying production layout mismatch.

**Confirmed code conflict:** `web/src/components/ui/select.tsx` provides `data-[size=default]:h-8` on `SelectTrigger` and `shrink-0 whitespace-nowrap` on item text. `CreateSessionDialog.tsx` asks the trigger to display the three-line `ProjectLocationDetails` with `h-auto`, but a data-attribute height rule can outrank it. The popup uses the anchor's width and hides horizontal overflow. This is a **source-derived** cause; no new production browser result is asserted.

**Prototype behavior now:**
1. Web 1440 / 1180 / 1024 → Project detail → New Session → examine *closed* Existing Location: Agent name, wrapping directory and status all remain inside a naturally tall trigger.
2. Click the trigger → a single anchored-width menu opens **in dialog flow**, so the dialog body remains the vertical scroll owner; each option wraps without `nowrap` or nonshrinking flex content. Select Test Agent → closes the menu with that same Agent and directory in the trigger.
3. Choose the external **Very long path / address** fixture → reopen; check all three lines still fit at every Web width. **Agent offline** fixture renders an offline line and disables Create, while the dropdown remains inspectable.
4. Arrow Up/Down cycles focus between opened options; Enter/Space selects via native button behavior; Escape closes the menu and returns focus to the trigger (and only the next Escape cancels the dialog). App continues using a separate full-height Location child picker.

**Fidelity:** The revised dropdown is a dependency-free HTML/CSS interaction mock of the *desired* Select presentation, not a working patch to `@base-ui/react/select`. Its option list is deliberately in-flow to avoid two nested scroll areas in this small mock; the production popup has portal/anchor semantics and needs separate browser proof. The existing Web/App shell/operation hierarchy is unchanged.

**Pending proof:**
- Mock: Chrome/Playwright check that `[data-location-trigger]` and each `[data-location-option]` contain all child text rectangles; `scrollWidth <= clientWidth` for trigger, menu, each option and Web dialog; pointer + keyboard navigation and focus/escape at Web 1440/1180/1024 plus constrained width.
- Production: exact-PR-HEAD Chromium Case on real `SelectTrigger` + popup in `project-session-create` flow and normal/long/offline cases (SC-07).
- Publication: source branch SHA, trusted Pages manifest `session-operation-surfaces-3089` entry and live HTML/readback at the same source SHA (SC-08). **GitHub source push alone does not prove public Pages freshness.**

**Knowledge Impact:** None — an existing design pattern's geometry/regression boundary, with no new product concept.
