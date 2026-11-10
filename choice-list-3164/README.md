# Select and Choice-item Visual Grammar — current vs candidate (#3164)

## Owners and links
- [Owning Requirement #3164](https://github.com/BestNathan/nession/issues/3164)
- [Overlay family already delivered #3142](https://github.com/BestNathan/nession/issues/3142)
- [PopupMenu baseline](https://github.com/BestNathan/nession/blob/staging/docs/design/design-system/patterns/popup-menu.md) — Web 28px one-line rows, App 44px interactive floor, Experience-scoped portal and scroll ownership.
- **Browser candidate (not presumed live):** https://bestnathan.github.io/nession/prototypes/choice-list-3164/index.html
- **Source:** `prototype/choice-list-3164/` at an immutable commit, to be pinned in the Issue after the shared gallery commit.

## Question

Base UI's primitives are correct interaction building blocks, but the Nession Select option still feels like an ordinary browser/native-like list. Which row anatomy, hierarchy and width treatment is aesthetically Nession, with restrained colors, precision, and no loss of accessibility or current product flow?

This is **not** a proposal to replace Base UI, rewrite selection semantics, or add another Design System layer.

## Baseline reviewed (2026-11-10)

- `web/src/components/ui/select.tsx` on staging: `SelectTrigger` uses a standard bordered single-line shadcn-like control with a content-height variant; `SelectContent` defaults to `w-(--anchor-width)` and `max-h-(--available-height)`; `SelectItem` is `text-sm py-1 pl-1.5 pr-8`, focus Accent and trailing check, optional `multiline`.
- `web/src/components/ui/{dropdown-menu,context-menu}.tsx` share the row hit band via `popupMenuItemBandClass`, not a rich resource visual grammar.
- `web/src/product/project/components/ProjectLocationsEditor.tsx`, `product/session/components/CreateSessionDialog.tsx` and `capabilities/env/components/EnvImportDialog.tsx` are representative choice consumers.
- Nession design direction: `VISION.md`, `PRINCIPLE.md`, `docs/design/visual-language.md`, `docs/design/design-system/patterns/{popup-menu,overlay-surfaces}.md`.
- **Current panel in this prototype is a code-informed visual approximation**, not a captured pixel-exact staging screenshot. The candidate is exploratory.

## Demonstrated candidate: two related item anatomies

1. **Simple / action or one-line choice**: a single primary title, optional leading mark, stable trailing check region, one quiet hover/focus surface. **Keep existing 28px Web and 44px App min targets** until approved changes to the PopupMenu contract.
2. **Rich / resource choice**: primary resource title, quiet optional type/Agent/source/availability, monospace path where meaningful, stable trailing selection check. Grows with content rather than a fixed 28px. In App its touch area is at least 44px, typically taller when rich.
3. **Width**: current popup approximates `anchor-width` by default; rich candidate may grow beyond Trigger up to a viewport-capped usable width so paths are readable. Long values wrap and remain accessible. This mock is an approximate positioning algorithm, not Base UI's collision engine.
4. **Status and selection**: selected = soft neutral surface plus aligned check, focus = slight neutral surface shift, unavailable = explicit text and disabled semantic (not just hue). Color signals state, not decoration.
5. **Dark**: use a related neutral ramp; no new product brand palette or decorative accent.

## Product viewport / IA

- Web: simplified `WebLayout → Sidebar + ShellMain → New Session Dialog → Agent / Location / Mode / ENV Select`.
- App: the same `New Session` intent shown in a full-height operation depth, with one Back action and no second capability or shell header.
- The full Web/App screen is an **IA approximation** based on current source ownership; it is not Chromium-confirmed product pixel fidelity. No Terminal content / live transport / external HTTP is used.
- The `np-page` header, Current/Candidate/Theme/Fixture toggles, viewport selectors and verification notes are **outside** `np-device`, not product chrome. Real CSS pixel width, no browser zoom or scaling.

## Reproducible walkthrough

1. Select **Current**, Web 1180; click Existing Location and observe the default narrow panel. Choose another available Location. Then **Candidate** at the same target and fixture to inspect hierarchy, width and selected state.
2. Open Agent, Connection mode and Environment; inspect simple vs rich row anatomy, check positions, unavailable row and hover. Press ArrowDown/ArrowUp/Home/End, Enter, Escape; disabled rows cannot be committed.
3. Choose Long paths/list; open Location/Environment. Scroll a long popup, inspect wrapped full path and selectable items. Current panel uses a more cramped one-line approximation.
4. Switch App 390/375 and test selection/keyboard again. App single-line row is at least 44 CSS px; richer rows are taller, preserving content.
5. Switch Dark, then Offline; observe disabled Agent/Location and unavailable Create. Switch No Locations; menu gives honest empty state and Create is disabled. Return Normal to recover.
6. Cancel and reopen from the work surface; name and selections persist in memory. Explicit Create shows a **mock-only notification** and closes the operation.
7. Web 1180 → App 390 → Web 1180 without reload; the layout changes with the selected Experience, not `window.innerWidth`. Test a choice after switching. Reset reloads the default candidate state.

## Fidelity and test evidence

- **Source/static:** `index.html`, `styles.css`, `app.js` use only local assets and the reusable `../prototype-frame-2758/{frame.css,frame.js}`; mandatory gallery/source anchors are present; no external libraries or network calls, no secrets.
- **JS syntax:** requires parse/smoke check against exact source after final writes. **Static tests do not establish browser behavior.**
- **Real browser:** Chromium + Playwright (Web 1440/1180/1024; App 375/390/430; external viewport width narrower than device) must measure actual geometry, stage scroll edges, keyboard selection, overflow, App hit areas, focus/dismissal and dark state. Pending unless observed; do not claim browser Pass based on this README.
- **Publication:** the public HTML link is a target only; `prototypes/manifest.json` and the exact-source SHA must be independently read back before claiming publication.
- **Not production:** does not import actual Base UI components. It is a proposal for `SelectItem` / `DropdownMenuItem` / `ContextMenuItem` recipes, not a React implementation, backend Session, native HTML `datalist` replacement or acceptance proof.

## Integration and consistency plan

If candidate approved:
- Record the revised item-role contract in `docs/design/design-system/patterns/popup-menu.md` and only the additional measurable consequences; keep Base UI keyboard/portal/stack owner from #3142 and #1066.
- Update generic `web/src/components/ui` recipe and use actual Project/Session/Env consumers as proof before broad migration.
- Audit/update impacted **existing** `overlay-system-3142` and `session-operation-surfaces-3089` prototypes where their popup visual behavior conflicts, or mark superseded source explicitly; never call an old screenshot new evidence.
- Use canonical production Chromium Cases and Design Gate; never pass visual fidelity using the mock alone.
