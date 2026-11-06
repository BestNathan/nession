# Files Workspace · Source-aware creation and editing

Owning Requirement: [#2751](https://github.com/BestNathan/nession/issues/2751). Related past infrastructure: #636 / #654 (Explorer), #1140 / #1174 (App navigator); sandbox enforcement is owned by #2681, **not** this prototype.

## Decision to validate

A selection is **not** the browsed directory and is **not** expansion. On Web, New file/folder/upload resolves a frozen destination: selected directory -> itself; selected file -> parent; otherwise current browser directory. A folder's context action explicitly overrides the selection. On App, the pushed directory is the default, and folder-specific actions explicitly name the target. Each action keeps a `sourceId`; no implicit host fallback when a sandbox source is selected/unavailable.

The prototype also checks read-first App file viewing, explicit Edit, dirty guard, duplicate-name rejection and stale-remote conflict resolution. It illustrates a minimal FileRef (`sourceId + path`) and scoped document state without claiming isolation or network behavior.

## Scenario / expected behavior

1. **Web:** Start in `src/`, expand/select `src/components/`. Hit New file. The form clearly says `Beijing Agent / Host · src/components/`; enter `Button.tsx` and Create. A new file appears under the selected directory and opens.
2. **Selected file:** Select `src/App.tsx`, then New folder. The captured destination is `src/`, not `src/App.tsx/` nor the previously selected directory.
3. **Context action:** Right-click (or use the row More button) on a directory, choose New file here; destination is that directory even when another item is selected. Toggle a folder disclosure arrow separately from selection.
4. **Errors:** Try creating `Button.tsx` again; keep form/name/target and show Exists; an invalid name with `/` or `..` is rejected before any mutation. The mock does not overwrite.
5. **Editing:** Open `src/App.tsx`, Edit, make changes. Try another file; a guard prompts to Keep editing or Discard. Simulate external update, then Save; show a version conflict and allow Reload remote or Keep local and retry **with an explicit confirmation**.
6. **Source:** Switch to `dev-session / Sandbox (mock)`; file tree changes and selected/open paths do not follow across source. Toggle source offline; render unavailable, never show host data as fallback.
7. **App:** Switch to App; enter `src` then `components`, use Add → New file. Destination is the pushed directory without a desktop selection mode; view file read-first, explicitly Edit, Back with unsaved guard.

## Representative states

- Initial/available; expanded vs selected vs open file; empty folder; created/revealed; form partially filled; invalid/duplicate; dirty/unsaved guard; remote conflict; offline resource source; reset/replay.
- Web master/detail and App push navigator. The App mode can be toggled on desktop for inspection; CSS also responds to narrow viewports.
- Keyboard: Tab controls, Enter submit, Escape dismiss where possible. Long-press/context menu is illustrated through explicit More actions.

## Fidelity

All files, source identities, versions, conflicts, latency, creation, saving, upload and availability are **deterministic mock data and local browser state**. No P2P/Relay, Agent RPC, Session authorization, SandboxPolicy, OS filesystem, GitHub credentials, real upload or backend write occurs. The sandbox label represents a selected mock source, not proof that a Session's mount namespace is readable or isolated. This branch does not implement production code. Product correctness, security and E2E remain pending under #2751.

## Test / review walkthrough

Open `index.html` in a browser. Try scenarios 1–7 above; reset returns the fixture to a known state. Inspect at desktop (~1440px) and narrow (~390px), including dialog layout, keyboard focus, scroll, enter/back, and conflict recovery.

- Static verification: standalone HTML, inline CSS/JS, no external dependencies or network.
- Source-level validation and real-browser verification status are recorded in the Issue/hand-off separately; mock self-interaction is not trusted production Acceptance.

## Artifact location

Shared orphan `prototype` branch: `files-workspace-2751/index.html`. Canonical Pages route after verified publish: https://bestnathan.github.io/nession/prototypes/files-workspace-2751/index.html . Direct source: https://github.com/BestNathan/nession/tree/prototype/files-workspace-2751 .

## Shared review frame — 2026-11-06

- **Entry / preview:** `index.html` is a directly accessible interactive review page using the shared `../prototype-frame-2758/frame.css`, `frame.js` and `review-bridge.*`. Its order is Requirement overview → 1:1 CSS-pixel product mock → interaction/fidelity details. Use the original [Requirement](https://github.com/BestNathan/nession/issues/2751) for the current design contract.
- **Behavior:** preserves this directory's existing state transitions; moves fixture controls, reset, test inspectors, and scenario narratives outside the product viewport wherever they are static. Device width controls and full-page Reset belong to the external harness.
- **Fidelity:** 源选择、目录创建、冲突恢复均为本地 FileRef 逻辑；深色原型配色尚需与当前 token 对照。. The original mock's local DOM/CSS is retained; this migration does **not** prove fidelity to React/shadcn, actual xterm, TerminalCapsule, App gesture geometry, or current generated design tokens.
- **Validation:** GitHub source structure and publisher-required source/gallery hooks checked. The new review frame needs an independent Chromium desktop/narrow-viewport walkthrough, keyboard/touch/scroll check, console inspection, and source-vs-fixture visual comparison; **those browser checks are not yet verified**. The public preview is **unverified** until `prototypes/manifest.json` reports the same commit SHA; mock results are never production Acceptance.
- **Publication:** keep the existing direct `https://bestnathan.github.io/nession/prototypes/files-workspace-2751/index.html` URL, but treat the immutable GitHub source commit as authoritative until Pages HTTPS/manifest readback succeeds.

## 2026-11-06 review and fixes

The previous 1:1 review frame could display Web composition inside an App 390 device because the product mock had a separate manual mode switch. It now observes `np:resize` and derives Web/App from the selected width, retaining draft state through mode changes. Context-menu coordinates and dialog containment are now relative to the simulated product box, not the reviewer's browser. The original full-page `.frame/.workspace` wrapper fills the selected device. Mock-only footer/source links stay hidden in the review frame; the runtime `../manifest.json` fetch/relink code was removed because only the trusted Pages publisher pins Source.

A V8 DOM-stub executed the current inline mock and verified Web → App 390 → Web 1180, root-relative menu code, and no manifest fetch. Synthetic Chromium verified the shared geometry technique; actual full deployed Click/Keyboard/Touch testing and comparison with current `FixtureWorkspace` are still pending. This mock still has a legacy dark visual palette, **not current production visual parity**.

## 2026-11-06 · Product fidelity slice against current Files components

**Canonical comparison source:** main `bb48ea565be2`: `design/generated/web.css`, `web/src/app/experiences/web/FilesWebLayout.tsx`, `web/src/app/experiences/app/FilesAppLayout.tsx`, `web/src/app/experiences/app/AppFilesDirectoryPane.tsx`, `web/src/capabilities/files/components/FileBrowser.tsx` and `FileViewer.tsx`.

- Added `product-fidelity.css`, loaded **after** the shared review bridge and scoped to the **product `#app` only**. It captures relevant semantic light-neutral role values, 208px Files navigation, editor-first whitespace, 28px navigation controls, 12.5px editor text, quiet status and selected rows; the surrounding reviewer page is unaffected.
- The Web view remains a Files-local fixed-width tree + elastic editor (not two equal columns). The App view remains a single navigation stack; the pushed file reader's **Back** appears at the left of its header and routes back to the folder. Dialog, selected directory, safe edit and conflict simulation are unchanged. Browser-width-based reflow is **not** used to choose App behavior.
- **Honest deviations:** this is static HTML/CSS and an in-memory fake FileOps provider, not React/shadcn, Explorer, CodeMirror, real WorkspaceDepth, real source ACL or active terminal. The prototype keeps a compact Files/source context toolbar to expose #2751 multi-location scenarios; the current production FilesWebLayout does not independently render this same toolbar. This remains an **explicit candidate**, not a proven component match.
- **Regression:** `node --test files-workspace-2751/visual-fidelity.test.mjs` (checked in); a V8 DOM-stub executed the current inline product script and checked **11/11** paths including Web split, selected-folder destination, App root/folder/file push/Back, Web return and semantic CSS. That check does not constitute a Node run, true Chromium screenshot, production E2E, or pixel parity. Real browser comparison remains open.
