# Session metadata prototype record (#2789)

This is the durable record of the interactive Session metadata prototype that
explored a display title distinct from tmux identity, inline title/description/
tag editing, conflict and offline recovery, and the Web/App Workspace depth.
The mock lives on the shared orphan `prototype` branch, not in the product
checkout; this page records what it demonstrates, where its immutable source
is, and what it does not prove.

## Preview and immutable source

- Preview (HTTPS, verified live 2026-11-06):
  <https://bestnathan.github.io/nession/prototypes/session-metadata-2789/index.html>
- Source revision (shared orphan `prototype` branch, not part of the product
  checkout):
  [`527d166ae77c8ae7f56c0fc02e044a461d43d578/session-metadata-2789`](https://github.com/BestNathan/nession/tree/527d166ae77c8ae7f56c0fc02e044a461d43d578/session-metadata-2789)
- The Pages `prototypes/manifest.json` was verified on 2026-11-06 to report
  source SHA `527d166ae77c8ae7f56c0fc02e044a461d43d578` and the
  `session-metadata-2789` entry (3 assets).

## Question settled

Is a Session's user-authored work context — title, description, tags — a
Session-owned display alias rather than a tmux rename; can it be edited in a
quiet, contained Workspace editor with truthful loading, legacy, saving,
conflict and unreachable-Agent states; and does the same interaction work at
Web desktop and App narrow depth without adding tags or cards to navigation
rows?

## Scenario the mock demonstrates

1. Web: open the selected Session's Workspace; read the metadata title,
   description and tags beside the unchanged tmux name and Session ID.
2. Web: Edit details, change the title and description, add and remove tags,
   Save; the navigation title follows while tmux identity and the route do not.
3. Web: Cancel discards the draft; switching Sessions does not replay a stale
   draft.
4. Web: the No metadata fixture falls back to the tmux name with empty
   description/tags.
5. Web: the Agent offline fixture reports the failure and never claims a save.
6. Web: the Remote revision conflict fixture keeps the draft until the user
   explicitly chooses “discard and load latest.”
7. Web: the Recreated name fixture shows the same tmux name with no inherited
   metadata.
8. App: switch to 430/390/375, open Workspace depth, edit and return; the
   capsule stays available and Back returns to the parent depth.

## Verified browser pass

The live preview was driven in real Chromium on 2026-11-06 at 1440×900 and at
the App's 390 CSS-pixel viewport:

- the page loaded from the published Pages URL (HTTP 200); its title is
  “Nession · Session Metadata · Interactive Prototype #2789”;
- Edit opened the editor with the stored title, Save updated the visible title
  and showed the “tmux name unchanged” notice;
- the conflict fixture kept the typed draft after the refused save, and the
  explicit reload showed the other device's title;
- the offline fixture showed the unreachable-Agent notice;
- the 390 size control reported “390 CSS px · 1:1”;
- no console errors or page errors occurred.

## Fidelity and limitations

- **Mock**: Sessions, revisions, timestamps, conflicts, Agent availability and
  persistence are deterministic in-page data. Nothing is sent over a network.
- **Not proven by the mock**: the Agent-owned metadata store, protocol
  round-trip, authorization, revision guard, tmux instance-identity fence,
  production React components, real keyboard/touch gestures or backend
  conflicts. Production proof belongs to #2789 Acceptance Cases SC-01–SC-05
  and the `session-metadata.spec.ts` browser suite.
- The static HTML/CSS approximates the current Nession design tokens and
  Session/Workspace shell; it is not pixel-identical to production.
- The mock is not an Acceptance receipt and must not be cited as production
  browser evidence.

## Synchronization

The product owners are
[session-item.md](session-item.md) for navigation identity and
[workspace.md](../../workspace.md#session-workspace-view) for the Workspace
Session view. The mock's display-title fallback, editor states and Web/App
depth were kept aligned with those owners. The durable Agent-side ownership is
recorded in
[`session-tmux-sdk-ownership.md`](../../../architecture/session-tmux-sdk-ownership.md#session-metadata-ownership-2789).
