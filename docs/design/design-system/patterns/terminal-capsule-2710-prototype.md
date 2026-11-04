# Terminal Keys / Quick Commands prototype record (#2710)

This is the durable record of the interactive prototype that settled the
terminal-tools slot design. The mock itself lives on the shared orphan
`prototype` branch, not in the product checkout; this page records what it
proves, where its immutable source is, and what it does not prove.

## Preview and immutable source

- Preview (HTTPS, verified live 2026-11-04):
  <https://bestnathan.github.io/nession/prototypes/terminal-keys-commands-2710/index.html>
- Source revision (shared orphan `prototype` branch, not part of the product checkout):
  [`bcb3e690d3f786f41cf477e99828654ca8e17519/terminal-keys-commands-2710`](https://github.com/BestNathan/nession/tree/bcb3e690d3f786f41cf477e99828654ca8e17519/terminal-keys-commands-2710)
- The Pages `prototypes/manifest.json` was verified to report that same source
  SHA. The published page adds a gallery navigation bar and a CSP; the mock's
  own bytes are otherwise the pinned revision.

## Revision for touch-scroll continuity (2026-11-04)

The first browser pass above covers the initial design. A follow-up correction
keeps a vertical drag owning the mock terminal while an upper panel is open and
prevents the clearance observer from resetting the gesture mid-drag; its source
revision is
[`0f8b80e5eecb75699a3815cab3d94e0457263cf0/terminal-keys-commands-2710`](https://github.com/BestNathan/nession/tree/0f8b80e5eecb75699a3815cab3d94e0457263cf0/terminal-keys-commands-2710)
(the code change landed in `2ea079815`, the documentation in `0f8b80e5`). That
revision was statically checked only — it was **not** re-verified against the
Pages manifest and has no new real-browser receipt. The 390×844 browser pass and
Pages proof above remain evidence for the first design pass, not for this
revised touch behavior. Production proof for the corrected
following → history transition is SC-10 / PR #2739.

## Question settled

Can Nession make real modifier chords and saved-command actions reachable on
mobile while preserving the approved composer/Peek relationship, and let the
terminal's live output reach just above the highest expanded capsule surface
without resizing the PTY?

## Scenario the mock demonstrates

1. `+` → capability entry → Keys or Commands.
2. Keys: one-tap Ctrl+C; Ctrl → X in the one-shot A–Z selector; Cancel;
   repeated arrows.
3. Commands: Insert fills the expression composer without execution; Run adds
   an execution event.
4. Composer tap returns to native typing without moving the composer.
5. Opening `+`, Keys or Commands moves the live bottom above the topmost
   surface; changing panel height while browsing history preserves the viewing
   anchor; scrolling back to the live bottom resumes following.

## Verified browser pass

The live preview was driven at 390×844 in a real browser:

- `+` menu opened and selected Keys and Commands;
- Ctrl+C emitted the mock `0x03` chord; Ctrl → X emitted `0x18`; Cancel cleared
  the selection without a write;
- Commands Insert filled the composer and returned focus; Run emitted the mock
  `[mock] RUN: git status ↵`;
- following clearance measured 511px with the live line above the panel; a
  history position (scrollTop 949) survived a panel height change (clearance
  406px) with `scrollMode=history`;
- the gallery's injected bottom navigation bar originally covered the mock's
  `+` and composer at this width; the prototype now reserves its height only
  when the nav is present. This was found by the browser pass, not by static
  inspection.

## Fidelity and limitations

- **Mock**: terminal output, saved-command inventory, connection status, key
  serialization/readout and command actions. No PTY, shell execution, xterm
  instance, network or persistence.
- The mock's clearance uses DOM scroll padding on a simulated terminal. It
  demonstrates the interaction, not a validated method for xterm's virtual
  buffer.
- **Not proven by the mock**: real PTY bytes and mode-dependent encoding
  (DECCKM and friends), xterm row/PTY/tmux stability, alternate-screen and
  mouse-reporting TUIs, touch scrolling, the #2657 direction pad, IME and device
  safe areas. Those are proved by the production implementation and its
  Acceptance Cases (SC-02/03/04/08/09/10 in issue #2710), not by this artifact.
- The mock is not an Acceptance receipt and must not be cited as production
  browser evidence.

## Synchronization

The production design owner is
[terminal-capsule.md](terminal-capsule.md#input-modes) and the interaction owner
is [interaction-semantics.md](../../terminal/interaction-semantics.md). Both were
updated in the same change as this record: one upper slot with a compact
Keys/Commands switch, one-shot modifier chords owned by the interaction runtime,
Insert vs Run on the existing saved-command owner, and a scroll-clearance value
separate from the composer fit occlusion.
