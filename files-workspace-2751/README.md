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
