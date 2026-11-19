# App Workspace unified interaction prototype record (#3971)

This is the durable record of the interactive App Workspace prototype that
settled the four joint decisions in #3971: one stack header, semantic content
surfaces, an icon-first action vocabulary, and inner-stack swipe. The mock lives
on the shared orphan `prototype` branch, not in the product checkout; this page
records what it demonstrates, where its immutable source is, and what it does
not prove.

## Preview and immutable source

- Preview (HTTPS, verified live 2026-11-20):
  <https://bestnathan.github.io/nession/prototypes/app-workspace-3971/index.html>
- Source revision (shared orphan `prototype` branch, not part of the product
  checkout):
  [`e9851e9d193997f756ba613499b3f59006613074/app-workspace-3971`](https://github.com/BestNathan/nession/tree/e9851e9d193997f756ba613499b3f59006613074/app-workspace-3971)
- The Pages `prototypes/manifest.json` was verified on 2026-11-20. It reports
  `source.sha=e9851e9d193997f756ba613499b3f59006613074`, the
  `app-workspace-3971` entry (`preview=prototypes/app-workspace-3971/index.html`,
  `assets=5`), and manifest SHA-256
  `c76187bf53158bb042ad8c52d12b8af600cb81df3c6f82c11589d251a0575a3e`.
- The published `index.html` SHA-256 is
  `696794c5001448fa11647aae5bfc51b134c0ea9e48baef00676a05dd11296886`. It is
  byte-identical to the immutable source HTML
  (`1c1dfddcaa91e392ae177606c09d77283cb93de4cba4f8b6d92f0e1e336d1261`) except
  the publisher's sanitized CSP `<meta>` and its pinned `View source` link.
- Earlier revision `df8c333ce2bf2a270216c4ac747fd53a97fb2b96` (token-only
  convergence, no interaction change) remains archived in the same artifact
  history and is not the current design source.

## Question settled

Does one App-owned stack header, semantic primary/secondary surfaces, a shared
icon vocabulary and a guarded inner-stack swipe produce one coherent App
Workspace experience across Claude Reader, Git Collection, Sandbox
Configuration and Files Editor — without a second page bar, a card-per-row
layout, or a competing gesture owner?

The decision was **yes, one App experience contract**, extending the existing
#3194 layout ownership and #3137 visual recipes rather than adding
capability-specific shells. The production contract is
[`interaction/app.md`](../../interaction/app.md), with the App depth/capsule
rules in [`workspace-navigation.md`](workspace-navigation.md).

## Scenario the mock demonstrates

The page hosts four reviewer presets outside the product viewport, all sharing
one App host, header, Capsule Zone and stack:

1. **Claude · Reader** — conversation root → Browse → Transcripts →
   Transcript → Record → Raw. Exercises the primary reading surface, the
   primary/secondary header lines, Browse as the priority icon, More with
   readable items, inner right Pop and left Forward, and the Stack Sheet's real
   ancestry.
2. **Git · Collection** — staged/unstaged groups → a pushed Diff. Exercises
   grouped contiguous rows on a primary collection surface and a pushed reader
   depth.
3. **Sandbox · Config** — Overview → Policy → parent. Exercises named
   configuration sections and a secondary form surface inside the primary page.
4. **Files · Editor** — file → Edit → dirty guard, then a preset switch.
   Exercises the editor-owned surface and the guard that refuses to discard
   unsaved work.

The header is the only page bar: `Back | primary title + truthful secondary
path/context | priority icon(s) | More`. The Capability Capsule stays at every
depth.

## Verified browser pass

The live public preview was driven in real headless Chromium (Playwright) on
2026-11-20 at a 1280×1000 review viewport with the product area at 390 CSS px:

- the page loaded from the published Pages URL with no console or page errors;
- the header showed `Claude Code` with the `session · nession-dev · active
  agent` secondary line, plus `Back to Terminal`, the Stack Sheet trigger,
  `Browse resources` and `More actions`;
- More opened a sheet whose entries carried icon + readable text (`Refresh`,
  `Copy resource reference`, `Navigation stack`);
- Browse → Transcripts changed the primary title to `Transcripts` and the
  secondary line to the real ancestor `Claude Code`;
- the Stack Sheet listed the root-first path `Claude Code → Transcripts` and
  an ancestor jump returned to `Claude Code`;
- Transcripts → Transcript → Record produced `Session transcript` and
  `Tool result`; an inner right drag translated the page frame by +125px and
  popped to `Session transcript`; a left drag translated by −120px and
  forwarded to the recorded `Tool result`;
- the Git preset showed a grouped Changes collection and a pushed
  `AppPageHeader.tsx` Diff; the Sandbox preset showed the Policies
  configuration surface;
- the Files preset opened `Edit file`, accepted an unsaved draft, and a preset
  switch raised `Discard unsaved changes?`; **Keep editing** preserved the
  editor and its header, **Discard & leave** landed on Git.

The screenshots and JSON transcript from that walkthrough were recorded with
the prototype verification on Issue #3971. They are mock-evidence only.

## Preserved history and supersession

- The same #3971 artifact keeps its earlier token-only revision and the unified
  interaction revision; neither is overwritten by the other.
- The linked Claude #3829 and mobile-swipe #2724 prototype pages carry in-place
  **historical/superseded** notices on the orphan branch, because their
  deep-detail/gallery presentation is no longer current visual evidence. They
  remain IA and outer-gesture references only.
- The production owners those issues established are **not** retired by this
  mock. `#3829` still owns Claude App routing and `#2724` still owns the outer
  spatial swipe/contact rules; the new prototype and production contract
  extend them.
- `docs/design/interaction/app.md` therefore continues to cite both issues as
  production owners; the supersession notice belongs to the prototype
  artifacts, not to the shipped behavior.

## Fidelity and limitations

- **Mock:** all sessions, conversations, records, Git state, Sandbox policy and
  Files content are deterministic in-page data. No Claude/Agent/Git/Sandbox/
  Files/network/auth write or real provider read occurs.
- **UI approximation:** the mock is a standalone HTML/CSS/JS approximation of
  the production component tree, not the production React composition. Token
  roles, 44px App targets, header/surface geometry and the gesture model are
  represented; exact production pixels and component internals are not.
- **Browser walkthrough limit:** the mouse-drag rehearsal requires the pointer
  release to stay inside the mocked viewport because the mock does not set
  pointer capture. Real touch keeps its original target by
  `Touch.identifier`; the production App path is proven by the SC-02..SC-05
  staging browser Cases, not by this mock.
- **Not proven by the mock:** production header/surface computed styles at
  375/390/430, real Chromium touch ownership with Terminal/PTY invariants,
  dirty-editor persistence beyond the mocked textarea, or any staging
  Acceptance criterion. Those remain the #3971 staging Cases and PR-stage
  Gate/Agent evidence.
- The mock is not an Acceptance receipt and must not be cited as production
  browser evidence.

## Synchronization

The production contract is
[`interaction/app.md`](../../interaction/app.md) plus
[`workspace-navigation.md`](workspace-navigation.md) and
[`composition.md`](../../composition.md). They own the stack header, semantic
content roles, icon action vocabulary and inner-stack gesture; this record and
the orphan prototype must change together when those decisions change.
