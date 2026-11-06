# Session Metadata / Workspace (#2789)

## Requirement and scope
- **Owner:** [Requirement #2789](https://github.com/BestNathan/nession/issues/2789)
- **Surface:** Session navigation → Workspace SessionDetails on Web; App Sessions → Terminal → Workspace Session depth.
- **Decision:** user-managed `title`, `description`, `tags` as Session metadata, distinct from existing `session_id = agent_id:session_name`, tmux identity, runtime and connection facts.
- **Out of scope:** input history, output history, JSONL history persistence, Session I/O observation or MCP scheduling; those require a separate model. No fabricated History tab.

## Prototype scenario and interaction questions
1. Open the selected Session's Workspace. Read human-friendly title, purpose and tags while preserving the tmux name, agent, cwd and activity context.
2. Edit title, description and add/remove tags; save and observe Session list row update, without renaming tmux or changing Session ID.
3. Edit then cancel; start an edit then select another Session to get a discard confirmation.
4. Switch fixture to **No metadata** to confirm fallback to the tmux name and empty description/tags.
5. Switch fixture to **Agent offline** and attempt a save: error, no silent success, preserve draft.
6. Switch fixture to **Remote revision conflict** and attempt a save: explicit conflict, then explicitly discard the draft to load the remote metadata; the stale draft is never silently replayed.
7. Switch fixture to **Recreated name**: mock new instance has same tmux name and route display, but no inherited metadata.
8. Switch between Web (1180 / 1024) and App (430 / 390 / 375). App uses Workspace depth and Back, rather than a miniature desktop sidebar. From Terminal return to Workspace. Reset to replay.

## Fidelity and source baseline
- Standalone static HTML/CSS/JS with local in-memory fixture; **no Nession services, model calls, filesystem mutations, PTY, tmux, auth or durable state**.
- Uses the shared [Prototype Review Frame #2758](../prototype-frame-2758/README.md) for external overview/preview/details, pixel-size controls, gallery and source slots.
- Product look was modeled against `main` owners: `web/src/product/session/components/SessionDetails.tsx`, `patterns/SessionItem.tsx`, `web/src/app/Sidebar.tsx`, `WorkspaceShell.tsx`, `WorkspacePanel.tsx`, `AppLayout.tsx`, `docs/design/composition.md`, `docs/design/visual-language.md`, `docs/design/design-system/patterns/session-item.md` and `design/generated/web.css` (current reference inspected 2026-11-06).
- Local CSS captures a limited subset of semantic `--nession-*` palette and control roles. **Not pixel-identical to production**: no React/shadcn, measured terminal font fitter, real keyboard/touch gestures, implicit multi-client synchronization or live server conflict detection.
- Product preview contains only product-relevant affordances/messages. Fixture selectors, Issue/source links, test instructions and fidelity notes remain outside the screen.

## Deterministic verification targets
- Run `node --check session-metadata-2789/app.js` from branch root, or parse it through the browser. Static HTML paths: `../prototype-frame-2758/frame.css`, `../prototype-frame-2758/frame.js`, `./styles.css`, `./app.js`.
- Browser: open `index.html` with static HTTP server, test sizes and all fixture flows above. Clicking actions should update in-memory state and never send network calls.
- Test `title||session_name`, edit/save and Cancel, duplicate tag rejection, offline/conflict non-save, same-name new identity, unsaved-change confirmation, switching screens and keyboard Enter tag creation.
- Before claiming a live Pages link, read `https://bestnathan.github.io/nession/prototypes/manifest.json` and compare its SHA with the exact `prototype` commit, then actually open the direct HTML.
- **Evidence status:** standalone JS syntax compiled; 21/21 mock-state checks and 7 static/asset assertions passed in an isolated V8 DOM-stub adapter against the checked-in smoke script, with asset readbacks from GitHub. The Node CLI entrypoint itself was not executed in this environment. Chromium screenshots/click-through, Pages manifest exact-SHA and real integration remain separate unverified evidence. No mock outcome can satisfy production SC-01 to SC-05.

## Source and preview
- [HTML preview route](https://bestnathan.github.io/nession/prototypes/session-metadata-2789/index.html) — only count as **verified** after live HTTPS + manifest SHA checks.
- [Shared prototype source](https://github.com/BestNathan/nession/tree/prototype/session-metadata-2789) — replace with an immutable commit SHA in the owning Issue after publication.
- [Prototype gallery](https://bestnathan.github.io/nession/#/prototypes).

## Repeatable mock smoke
From the `prototype` branch root:

```sh
node session-metadata-2789/smoke-test.mjs
```

This uses only built-in Node APIs, exercises the HTML entry, shared-frame relative assets, Session title fallback, editing, tag validation, unsaved confirmation, offline/conflict/recreated states and App size switch. It does not run a browser, which still requires separate Chromium verification.


## Web 1:1 review frame regression — 2026-11-06

The Web 1180px preview could lose its left side when the centered device exceeded the review stage's padded content width. In addition, the App 390px selector updated only the outside device because the shared `np:resize` event did not bubble to this prototype's page-level listener. Both were **shared frame bugs**, not Session Metadata domain changes. Fixed in `prototype-frame-2758/frame.css` and `frame.js`: overflow-safe centering, wider reviewer frame, outline outside exact content width, event bubbling. The product still derives Web/App from the target width and preserves Session semantics. A local Chromium CSS-geometry reproduction covered browser widths 1440, 1280 and 960; an exact live deployment and interactive Chromium click-through are still separate checks.

Regression: `node --test prototype-frame-2758/frame-geometry.test.mjs` plus existing `node session-metadata-2789/smoke-test.mjs` (the latter uses a DOM stub, not a browser). Recheck the published `prototypes/manifest.json` SHA before describing the Pages URL as refreshed.

## 2026-11-06 · Product information-architecture correction (supersedes frame-only review)

The previously fixed 1180px box geometry and bubbling `np:resize` event did **not** prove that the **inside** was the current Nession UI. This revision corrects semantic ownership in the actual Session Metadata simulator, not merely its palette or a hidden header.

| State | Product source owner → content owner | Prototype DOM assertion |
|---|---|---|
| Web active Session / Workspace | `WebLayout → Sidebar(Agents + flat Sessions) + ShellMain → WorkspacePanel → WorkspaceShell → Session capability → Session metadata` | `web-layout`, `sidebar`, `shell-main`, `workspace-shell`, `workspace-tool-content`, `workspace-tool-session` |
| Web Terminal | Same WebLayout, Terminal root and its contextual conversation Capsule with separate Workspace destination | `terminal-surface`, `terminal-capsule-zone` |
| App Workspace | `AppLayout/AppLayers → WorkspacePanel → one AppPageHeader(Session, Back to Terminal) → WorkspaceShell → Session capability` | `app-layer-root`, `app-layer-workspace`, exactly one `app-page-header`; no Web Sidebar or independent capability Back |
| App Terminal / Sessions | Terminal is the root; Sessions is a separate navigation layer; neither is a miniature Web sidebar or an extra Terminal page banner | `app-layer-terminal` with conversation capsule but **no** Workspace page header; `app-layer-sessions` as separate navigator |

**Changes:** `app.js` now explicitly composes the Web Session/sidebar ShellMain and App spatial layers; the old App Terminal's fabricated `Terminal` header and reversed capsule composition were removed. The Session editor remains capability-local, with unchanged title fallback, immutable tmux identity, tag validation, cancel/dirty guard, conflict/offline and same-name Session replacement fixtures. `styles.css` contains product-scoped layout rules; the shared #2758 frame is untouched.

**Current-versus-proposed boundary:** the metadata form and durable title/description/tags are the #2789 interaction fixture, not proof that the `main` `SessionDetails.tsx` renders identical HTML. The shell owner graph follows inspected `main` at `f3bc32b473ea`; the business UI is still an independently drawn HTML approximation. No live server/Agent/persistence or React/CodeMirror interaction is implied.

**Verification:** `session-metadata-2789/smoke-test.mjs` now has **35/35** assertions passed when the real checked-in JS and assertion script were evaluated in an isolated V8/DOM-stub harness. Coverage includes the newly verified owner tree and Web Sidebar collapse, one App header, App Terminal without a Workspace page header, TerminalCapsule + contextual entry, Sessions layer separation, and Web→App→Web, alongside existing metadata scenarios. This is **not** a native Node CLI execution, headless Chromium/Playwright screenshot or production UI pixel parity proof. At minimum, a real browser must measure the product and compare the current `FixtureShell` / `FixtureApp` at 1180/1024 and 390/375 CSS px before claiming visual fidelity.
