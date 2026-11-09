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
- **Web Create:** Project detail → New Session → responsive 640px dialog; Agent and directory on distinct lines, ENV summary/options, submit. Ordinary New Session stays unbound to Project.
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
- **Static checks:** files and relative paths reviewed. Exact JavaScript parser and real browser click-through must still be verified.
- **Browser verification:** **Pending** actual Chromium+Playwright testing on this source for Web/App width, composition, focus, Back, keyboard, horizontal scroll/overflow and console errors.
- **Pages publication:** **Pending** until the trusted Pages publisher exposes exact source SHA in public prototypes/manifest.json and direct HTML readback. Prototype branch push alone is NOT live proof.
- **Production Acceptance:** all #3089 SCs remain Pending; prototype is not an authenticated production Case.
- **Evidence authority:** independent published Pages readback + immutable commit identifies mock revision; mock success does not demonstrate actual Session creation.

## Links

- Preview (not yet deployment-verified): https://bestnathan.github.io/nession/prototypes/session-operation-surfaces-3089/index.html
- Pages gallery: https://bestnathan.github.io/nession/#/prototypes
- Mutable source: https://github.com/BestNathan/nession/tree/prototype/session-operation-surfaces-3089
- Immutable source: pin exact final prototype branch HEAD SHA after the final commit.

## Non-goals

No production React code, no new backend endpoint, no changes to domain semantics, no Managed EROFS path (#3062), no Session→Project binding (#3082), no physical iPhone/Safari proof.