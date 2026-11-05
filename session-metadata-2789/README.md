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
- **Evidence status:** standalone JS syntax compiled; 19 deterministic V8 DOM-stub assertions passed on the first revision. A checked-in Node smoke-test reproduces the revised decisions (run it locally before claiming a Node result). Chromium screenshots/click-through, Pages manifest exact-SHA and real integration remain separate unverified evidence. No mock outcome can satisfy production SC-01 to SC-05.

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
