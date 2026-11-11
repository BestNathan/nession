# Unified Overlay & Operation Surface System — interactive candidate (#3142)

## 2026-11-11 Dialog anatomy regression comparison — [Bug #3298](https://github.com/BestNathan/nession/issues/3298)

This is an **in-place mock revision**, not a production component change. #3142 remains the visual owner; no competing prototype directory is created. Source review: staging `web/src/components/ui/dialog.tsx`, Session/Project consumers and current #3142 browser cases. The observed header/footer issue was reported by the user; the legacy illustration is a **source-inspired approximation, not a measured screenshot**.

**Proposed contract:** Dialog shell owns viewport clamp and surface, Header and Footer are opaque, full-width **non-scrollable bands**, Body alone has `min-height:0;overflow-y:auto`. The Footer is flush with the surface bottom with no negative-margin sticky compensation; short dialogs remain content-sized. App retains one Back/header and safe-area actions.

**Walkthrough:** Web 1180/1024 → Long path/many rows → New Project → toggle `Corrected · three zones` (default) vs `Legacy approximation · Web` → click Scroll top/middle/bottom. Read the live DOM geometry report (Header side coverage; Footer edge; CSS scroll owner; scroll distance). Repeat with New Session/Location child Select and compact Rename. Switch App 390/375/430/844×390, Offline/Invalid and Back/Cancel. Only the Web mock's legacy mode intentionally models a faulty anatomy; App keeps its candidate operation structure.

**Verification boundary:** geometry report is diagnostic code inside a deterministic sanitized HTML mock. Chromium execution is still necessary for actual rendered geometry and focus/keyboard/touch behavior, and trusted Pages manifest+HTML SHA readback is necessary to label a public revision published. Existing #3142 production SC receipts do not prove #3298; the React correction and new production browser Acceptance remain Pending.


- [Owning Requirement #3142](https://github.com/BestNathan/nession/issues/3142)
- **Browser HTML preview (requires verified Pages publication):** https://bestnathan.github.io/nession/prototypes/overlay-system-3142/index.html
- **Shared orphan source:** `prototype/overlay-system-3142/{index.html,styles.css,app.js,README.md}`; pin the immutable commit in the Issue after gallery update.
- Reference: #3089 Session/Project operation prototype, #3128 historical sticky footer fix and #3298 shared anatomy regression. The open #3137 owns content hierarchy/visual grammar; this prototype owns **temporary overlay presentation and behavior**, not resource detail layouts.

## Product question

Can Nession preserve one coherent and precisely specified temporary-interaction language across Dialog/AlertDialog/Menu/Select/Popover and Web/App, without flattening all operations into the same modal size or inventing a universal layout DSL?

Candidate decisions illustrated:
1. **Anchored contextual choice:** Menu/Select/Popover near trigger; no extra product shell. In a modal, child choice takes precedence over parent dismiss.
2. **Compact**: Rename and Delete Project confirmation (focused question, no unnecessary fields).
3. **Standard**: Web New Session (room for Agent/location/env).
4. **Wide**: Web New Project (multiple Agent/path rows, single body scroll).
5. **App**: Attach intention → short sheet; Connection settings → full-height depth; New Session/Project → full-height operation, child location/env selection; destructive confirmation remains concise; single visible header/back owner for pushed depths.
6. **Common visual rules**: one restrained surface treatment, stable header/footer with an opaque footer, body-only scroll, consistent close actions, honest error/disabled and long-path handling.

These numbers are **exploratory design roles**, not yet approved product token values: Compact ~440, Standard ~640, Wide ~760 CSS px, clamped to screen. Production #3089 remains the source of business-specific Attach/Create semantics.

## Product surface / fidelity baseline

- Reference sources inspected: `VISION.md`, `PRINCIPLE.md`, `docs/design/visual-language.md`, `docs/design/interaction/{web,app}.md`, `docs/design/design-system/components.md`, `web/src/components/ui/{dialog,alert-dialog,popover,select,dropdown-menu,context-menu,tooltip}.tsx` on main/staging (2026-11-10).
- Web shell ownership concept: WebLayout → Sidebar (Sessions / Projects) + ShellMain → current Terminal or Workspace → local operation. App concept: AppLayers → Sessions / Terminal / Workspace → one operation depth/header. Overlay is a **product-host-owned temporary interaction**, not an extension shell.
- The layout is a **sanitized, approximate visual reconstruction** of the current Nession product, not a copy of its React DOM. **IA fidelity is not independently Chromium-verified**, and the App spatial context strip is a simplified context cue. **Do not treat 1:1 frame widths as pixel or IA parity.**
- Product fixture: Dev shell, Agent alpha/beta, Workspace tools, `/workspace/nession`, public dummy `example.invalid`; no private address, token, API or user data.

## Primary interactive walkthroughs

1. Web 1440 → **New Session**: edit name, choose a Location with a wrapped path, choose multiple ENV files, Cancel/reopen, then explicitly Create. Test `Escape` when a dropdown is open; first Escape closes the child choice, not the parent.
2. Web 1180/1024 → **New Project**, set Long path fixture, scroll the form through eight Location rows while Header/Footer remain stationary; Add/Remove Location; confirm controls fit.
3. **Rename Project** and **Delete Project**: compare Compact vs confirmation; Cancel never deletes; Delete explicitly confirms a **mock** side effect.
4. **Contextual choices**: open anchored Session menu and informational Popover; verify they remain visually secondary and their choices are reachable.
5. App 390 / 375 → **Attach** sheet → **Connection settings** full-height depth → Back → Cancel / Attach. Save settings must not perform an attach.
6. App 390 / 375 / landscape → **New Session** pushed full height → child Location / Environment pick → Back, draft preserved → Create. App New Project uses stacked existing-location editors.
7. Switch Web 1180 → App 390 → Web 1180 without reload. Product composition must follow selected Experience; external review browser width must not shrink the 1:1 device. Click a primary action after switching.
8. Offline and Invalid fixtures: read errors and disabled primary CTAs, retry with Normal. Reset reloads to a known baseline.

## Preview page structure

`index.html` uses shared `../prototype-frame-2758/frame.css` and `frame.js` and the required `data-nession-prototype-frame="v1"` source/gallery anchors. The product mock is isolated in `#nession-product` under the measured `np-device`; scenario toggles are outside. No external runtime dependencies.

## Test / evidence boundaries

- **Source:** files created on shared orphan `prototype` branch; inspect pinned SHA and `README.md` / gallery in the Issue after final commit.
- **Static smoke:** verify one gallery anchor and one source anchor, local asset paths, semantic class/role coverage, JS syntax, prototype-directory link, long/disabled fixtures and no external calls; a source check is not browser proof.
- **Browser:** Chromium + Playwright must inspect 1440/1180/1024 Web and 375/390/430 App and 844×390 landscape, including simulated child popups, focus and target scroll dimensions; **Pending until actually executed**, no fabricated Pass.
- **Publication:** direct Pages HTML is **unverified** until the trusted publisher refreshes and `prototypes/manifest.json` is matched against pinned source SHA; source push alone is insufficient.
- **Production:** no React modifications, transports, persistent Session/Project mutations, native keyboard or runtime data. No SC #3142 production Acceptance inferred from this mock.

## Next decision for implementation

After visual review, codify the size-role + overlay-stack/portal/scroll ownership in a focused canonical design-system pattern, consume it from generic UI primitives, and validate with source-aligned production browser tests. Preserve #3089/#3128's completed semantics and #3137's distinct content-recipe owner.
