# Claude Memory reader prototype record (#2742)

This is the durable record of the interactive Claude Code Auto Memory reader
prototype revision that explored rich Markdown, frontmatter, linked navigation,
fragment recovery and partial reads. It is a revision of the same
`claude-memory-2689` artifact, not a second Memory product or a duplicate
product shell.

## Preview and immutable source

- Preview (HTTPS, verified live 2026-11-06):
  <https://bestnathan.github.io/nession/prototypes/claude-memory-2689/index.html>
- Source revision (shared orphan `prototype` branch):
  [`ddd62bd13794c5120bd5e347eabd180821b2c291/claude-memory-2689`](https://github.com/BestNathan/nession/tree/ddd62bd13794c5120bd5e347eabd180821b2c291/claude-memory-2689)
- The Pages `prototypes/manifest.json` was verified on 2026-11-06 to report
  source SHA `527d166ae77c8ae7f56c0fc02e044a461d43d578` and the
  `claude-memory-2689` entry (3 assets). The `claude-memory-2689` files at that
  published SHA are byte-identical to `ddd62bd1`, which is the immutable pin for
  this reader revision.

## Question settled

Can a user read the current Session's Claude Code Memory as a document — rich
Markdown, YAML/TOML frontmatter, in-snapshot relative links and fragments — while
the reader stays inside the existing Claude Code capability and refuses paths
outside the resolved Memory directory?

## Scenario the mock demonstrates

1. Terminal → Context Capsule `+` → Claude Code Peek → Workspace Memory.
2. `MEMORY.md` renders headings, blockquote, lists/checklists and inline links.
3. The inline **架构约束** link opens `architecture.md`, shows YAML frontmatter as
   metadata, and reaches `#session-boundary` after render.
4. The index link returns to `MEMORY.md`; **交互原则** shows TOML frontmatter.
5. **恢复记录** loads a partial chunk: the target heading is not yet available,
   the prototype says so, and **继续读取** completes the file and scrolls to it.
6. Missing targets and traversal examples are blocked in the reader; safe HTTPS
   docs keep the normal external-link policy.
7. The raw/preview toggle compares source with the rendered document.
8. At 390 CSS px the file list and reader are push/detail states inside the
   existing App shell, with the Capability Capsule still present and the reader
   owning its own scrolling.

## Verified browser pass

The live preview was driven in real Chromium on 2026-11-06 at 1440×1000 and
390×844:

- the page returned HTTP 200 with the title “Nession · Claude Code Memory
  Markdown reader · #2689 / #2742” and no console or page errors;
- the index opened; the inline topics links selected `architecture.md`,
  `interaction.md` and `topics/recovery.md`; architecture rendered YAML
  frontmatter, a table and a Rust code block; interaction rendered TOML
  frontmatter;
- `topics/recovery.md` showed the partial notice and the deferred-fragment
  notice; **继续读取** removed both and rendered **Retry strategy**;
- `missing.md` displayed the in-reader missing notice and left the index visible;
  `../private.md` rendered as a blocked, non-navigable reference;
- the raw/preview toggle switched source and rendered views;
- at 390 CSS px the file list and the pushed detail were both usable inside the
  existing App shell.

## Fidelity and limitations

- **Mock**: files, frontmatter, chunks, sessions, repositories, timing and
  conflicts are deterministic in-page data; no Claude installation, provider
  read, filesystem, websocket, auth or AI call is involved.
- **Not proven by the mock**: the provider's canonical root/symlink/containment
  checks, the protocol read boundary, the production shared Markdown pipeline,
  real keyboard/touch gestures or actual responsive React layout. Production
  proof is the #2742 Acceptance Cases and the `fixture-workspace` browser
  suite, not this artifact.
- The mock renderer is a deliberately small safe-subset renderer, not the
  production `web/src/shared/markdown` pipeline.
- The mock is not an Acceptance receipt and must not be cited as production
  browser evidence.

## Synchronization

The product contract is
[`docs/architecture/claude-code-memory.md`](../../../architecture/claude-code-memory.md#web-reader-and-link-navigation),
which owns the Web reader/link boundary. This prototype and that owner must
change together when the reader's link or partial-content semantics change.
