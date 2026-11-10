# Session operation surfaces · Web/App — interactive prototype (#3089)

**Owning Requirement:** https://github.com/BestNathan/nession/issues/3089

**Field-alignment revision:** [#3136](https://github.com/BestNathan/nession/issues/3136) — this same prototype is revised in place; do not create a competing mock.

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
- **Web New Session:** Project detail → New Session → responsive 640px dialog; field order is Existing Location, Session Name, Env Files (optional), all using identical label/control left edges and spacing. Open the content-sized dropdown, select Agent+directory and verify the closed trigger retains status and wrapping path. Ordinary New Session remains unbound to Project.
- **Web New Project:** Sidebar → New Project → responsive 720px dialog. Align Name, Description, Git URL/ref, Existing Locations (optional), and Image digest field with one form geometry. New Project starts with no locations; Add Location creates Agent Select/Directory textarea row whose labels and input *top edges* line up; Remove is aligned with the input row. Settings rehydrates existing locations without editing persisted Project until Save.
- **App Create:** Project detail → New Session → full-height operation page, child Location and ENV selectors, Back preserving draft, explicit Create opens new Session. Project Create/Settings uses the same full-height layout but stacks Agent/Directory controls in a single column with a bottom CTA. One App Project header owns the title.
- **Scenarios:** New Project empty vs Settings populated locations, Add/Remove, long paths and URLs, offline Agent, multiple locations, ENV options, cancellation and return to the same navigation context.
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


## Dialog alignment correction — 2026-11-09 follow-up

**Owner feedback:** Both **New Project** and **New Session** were visibly misaligned in the published mock. The earlier dropdown-only fix had not evaluated the entire form geometry.

**Source audit:** Against `staging` `ProjectFormFields.tsx`, `ProjectLocationsEditor.tsx`, `ProjectDialogs.tsx` and `CreateSessionDialog.tsx`:
- The prior New Project mock had omitted Description, Git URL/branch and image digest; it showed the live Project's locations at creation time, whereas the actual Create form may start with no locations. These are corrected in the mock.
- The old `.location-editor {align-items:end}` paired a one-line Agent field with a taller Directory textarea and staggered their labels. The revised editor uses top-aligned labels and controls in a responsive `minmax(0,...)` grid. App stacks controls.
- The prior New Session mock displayed Session Name before Existing Location, used an all-caps section heading for the latter and a separate ENV card title. The revised mock follows production field order with a shared `dialog-form`/field-label rhythm.
- Sidebar **New Session** and **New Project** actions now use identical button/icon anatomy. App Project detail no longer duplicates the Project name beneath its host page header.

**Review scenarios for Chromium:**
1. Web 1440/1180/1024: open New Project, assert all form controls share the dialog's horizontal content edges; add Location, assert Agent/Directory labels and *control top edges* are aligned and all control widths stay within the form; remove, cancel, reopen to confirm draft resets; save a name-only Project.
2. Web Project detail → New Session, check trigger/field horizontal edges, opening/closing and changing Location, long-path fixture with no horizontal overflow, keyboard focus and ESC.
3. App 390/375 and landscape 844×390: New Project/Session are full-height and use stacked fields, one page header and anchored CTA; long Project forms scroll in the middle. Return/back leaves previous state intact.
4. Switch Web→App→Web and repeat the same controls. Compare the actual dimensions of the two dialog contents, not only whether button labels are visible.

**Fidelity & proof:** This mock uses the current design token snapshot but is not the React UI. The changed prototype is not considered browser-verified until a new exact-SHA Chromium/Playwright run checks these cases; a previous successful Pages deployment or the JavaScript source parser is not sufficient. Production issues SC-07/SC-08 remain independent Pending obligations.

**Knowledge Impact:** None — correcting geometry and fidelity of existing Session/Project interactions, no new domain concepts.


## Component-level correction — 2026-11-09: Location and Env anatomy

**User correction:** The earlier “6/6 geometry” result missed obviously broken Env controls and an oversized/mismatched Location Select. On the actual Chromium screenshot, `dialog-form .field input` styled every `<input>`, including Env checkboxes: those inputs inherited full width and 42px height. The old mock also put online status on every Location dropdown option, and its expanded options occupied normal document flow, shifting subsequent fields. These defects invalidated any claim of visual fidelity despite passing outer box tests.

**Source of truth:** `staging:web/src/product/session/components/CreateSessionDialog.tsx`, `CreateSessionParts.tsx`, `web/src/capabilities/env/components/EnvFileMultiSelect.tsx`, `AppCreateSessionSurface.tsx` and the shared `select.tsx`. The React primitives remain unmodified by this prototype correction.

**Rebuilt visuals and interactions:**
- Web Existing Location: trigger contains Agent, path and *Agent online/offline*; options contain only Agent/path, with selected indicator. Height grows only as required by real text; control and popup have exactly the same anchor width; the popup overlays instead of shifting Session Name/Env fields.
- Web Env Files: 32px search input, 224px separately scrollable list, compact 16×16 selection checkmarks, file icon, full filename, source badge (`server` / `agent:build-agent`), var count and selected-file count. Search and selection are functional. No simulated raw checkbox-in-form styling.
- App New Session order: Session Name → Existing Location → Environment files (matching the App implementation, **not** copied from Web). The App summary is a single disclosure row; the child Env page has a search and a page-scrollable list, without a nested fixed-height box.
- Project's Agent/Directory row retains its distinct Input/textarea semantics; Web Remove is an icon-sized control, App Remove is full-width. No change to Project/Session API objects.

**Chromium recheck** for exact source `9c48f466248149707eaffa2c2d06928318eed031`:
- [Ephemeral Task #42639910237](https://github.com/BestNathan/nession/actions/runs/42639910237) successfully executed a source-pinned, secretless Chromium run: Web 1440/1180/1024 and App 390x844/375x812/844x390 (6/6 diagnostic cases).
- Measured Web Location trigger **594px wide × 68px high** (ordinary path), menu **594px wide**, item heights **50px** with no status duplicated in the options, no form displacement on opening, 0px horizontal overflow.
- Web Env search **32px** high, each selection box **16×16px**, list **224px** high; three badge/var rows, filter by text and selection update checked. App child Env search **32px**, three rows without fixed list height; selections retained on Back.
- The run captured screenshots of Web Session closed/open and App Session/Env (diagnostic log). These checks prove the **mock** at that exact source, not production React fidelity or accepted SC-07.

**Critical distinction:** Source-aligned component anatomy is a better approximation; this remains a dependency-free static mock rather than `@base-ui/react` / React itself. #3089 stays open until the production Select implementation is fixed and authenticated Acceptance verifies the real UI. Publication verification is independent of the browser diagnostic.


### Follow-up: compact top-aligned Project Location fields (#3136)

This revision supersedes the earlier 42px mock baseline. The Web Project editor
now follows one field-row rule: Agent Select and Directory textarea are
top-aligned peers on the Experience control band (**32px Web**, **44px App**);
the Directory is a content-sized textarea that starts at the band and grows on
a wrapped long path; the Remove action sits in the label slot above the band,
so it aligns with the controls rather than the bottom of a grown field. App
stacks full-width 44px controls with the same growing Directory. The earlier
42px diagnostic is historical. Chromium verification of this revision is
recorded on Issue #3136 (SC-03); the mock remains prototype evidence, not
production parity.

The earlier source-only “6/6” result checked **outer form alignment**, not Env child geometry, and should not be interpreted as proof that the earlier visual was correct. The subsequent [component-level Chromium run #42639910237](https://github.com/BestNathan/nession/actions/runs/42639910237) covers inner search, checkbox, list and popup dimensions explicitly; [long Location path run #42640529645](https://github.com/BestNathan/nession/actions/runs/42640529645) checked 594px control/popup width and long-path wrapping at Web 1440/1180/1024 (3/3 Pass). These are diagnostic mock results, not a replacement for production SC Acceptance.
