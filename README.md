# Nession Prototypes

**Purpose:** a dedicated, history-isolated branch for **all** clickable design prototypes.

- **Branch:** `prototype` (one shared branch, never one branch per Issue).
- **Directory convention:** `<topic>-<issue-number>/` (one prototype per directory; revisions stay inside that directory).
- **Each prototype:** `index.html` (standalone browser UI), `README.md` (scope, data/behavior fidelity, related Requirement).
- **No runtime coupling:** mock-only assets, never production Web/API, secrets, or live user data.
- **Event-driven publication signal:** the only permitted non-mock file is `.github/workflows/prototype-changed.yml`. It runs on `prototype` pushes with **read-only permissions** and emits a completion signal. No checkout, secrets, deploy privileges, build artifacts, script execution, or direct dispatch. The trusted `main` `Deploy / Public Pages` workflow owns sanitized publishing and HTTPS verification. See [main-owned authoring Skill](https://github.com/BestNathan/nession/blob/main/.claude/skills/nession-prototype/SKILL.md).
- **Links from Requirements:** use a pin to the exact **prototype commit SHA**, and move the link when the design changes.
- **Hosting:** the main-owned `Deploy / Public Pages` pipeline publishes an inert, sanitized static copy from the pinned `prototype` SHA at [Nession Pages / Prototypes](https://bestnathan.github.io/nession/prototypes/) when the main Pages workflow receives the unprivileged push signal (or its scheduled/manual triggers). A direct preview is `https://bestnathan.github.io/nession/prototypes/<topic>-<issue-number>/index.html`. These links are only confirmed live after exact HTTPS readback; do not confuse a source browser with a rendered preview.
- **Source:** keep the separate GitHub URL `https://github.com/BestNathan/nession/blob/<published-sha>/<topic>-<issue-number>/index.html` for exact provenance. Preview pages expose this with **View source**.
- **Timing:** prototype pushes start a read-only Change Signal workflow; main's trusted Pages workflow publishes when it completes successfully. Commits made with GitHub Actions' default `GITHUB_TOKEN` are not guaranteed to trigger downstream workflows; use an approved writer identity. Always check the published `prototypes/manifest.json` SHA before claiming a refreshed preview.
- **Evidence:** mock HTML is design discussion material, **not Acceptance evidence**.

## Catalog

| Workspace Work capability / WorkContract, revisions, Criteria, Thread and source adapters | [#2541](https://github.com/BestNathan/nession/issues/2541) | [Interactive HTML](work-contract-2541/index.html) · [Scenario & fidelity](work-contract-2541/README.md) |

| Session Metadata / editable title, description and tags | [#2789](https://github.com/BestNathan/nession/issues/2789) | [Interactive HTML](session-metadata-2789/index.html) · [Scenario & fidelity](session-metadata-2789/README.md) |

| Shared Prototype Page Kit (review-frame components, three regions) | [#2758](https://github.com/BestNathan/nession/issues/2758) | [Interactive HTML](prototype-frame-2758/index.html) · [Reusable CSS](prototype-frame-2758/frame.css) · [Behavior](prototype-frame-2758/frame.js) |

| Prototype | Requirement | HTML |
|---|---|---|
| Files Workspace / source-aware selection, creation and safe edit | [#2751](https://github.com/BestNathan/nession/issues/2751) | [Interactive HTML](files-workspace-2751/index.html) · [Scenario & fidelity](files-workspace-2751/README.md) |
| AI Workspace (Progressive Action Space + Pending Goal + Jev mock) | [#2221](https://github.com/BestNathan/nession/issues/2221) | [Interactive HTML](ai-workspace-2221/index.html) · [Protocol](ai-workspace-2221/PROTOCOL.md) |

| AI Conversation (Text → business component → Text) | [#2254](https://github.com/BestNathan/nession/issues/2254) | [Interactive HTML](ai-conversation-2254/index.html) · [Protocol](ai-conversation-2254/PROTOCOL.md) |
| Fixed-column Terminal / real CSS font-size simulator | [#2487](https://github.com/BestNathan/nession/issues/2487) | [Interactive HTML](terminal-fixed-cols-2487/index.html) · [Scenario & fidelity](terminal-fixed-cols-2487/README.md) |
| Terminal Clipboard Protocols / transient permission & unsupported states | [#2598](https://github.com/BestNathan/nession/issues/2598) | [Interactive HTML](terminal-clipboard-2598/index.html) · [Scenario & fidelity](terminal-clipboard-2598/README.md) |

| Agent Workspace / current-Session process tree + collapsible, grouped Agent/Process details | [#2514](https://github.com/BestNathan/nession/issues/2514) | [Interactive HTML](agent-process-discovery-2514/index.html) · [Scenario & fidelity](agent-process-discovery-2514/README.md) |

| Session Environment Workspace / ordered binding, prompt convergence | [#2654](https://github.com/BestNathan/nession/issues/2654) | [Interactive HTML](environment-session-2654/index.html) · [Scenario & fidelity](environment-session-2654/README.md) |
| Git capability / GitHub repository context | [#1290](https://github.com/BestNathan/nession/issues/1290) | [Interactive HTML](git-github-1290/index.html) · [Scenario & fidelity](git-github-1290/README.md) |

| Mobile Terminal long-press arrow gesture | [#2657](https://github.com/BestNathan/nession/issues/2657) | [Interactive HTML](terminal-direction-2657/index.html) · [Scenario & fidelity](terminal-direction-2657/README.md) |

| Public Knowledge Explorer / topic, article, evidence and global changelog | [#2664](https://github.com/BestNathan/nession/issues/2664) | [Interactive HTML](pages-knowledge-2664/index.html) · [Scenario & fidelity](pages-knowledge-2664/README.md) |

| Claude Code Auto Memory / Session-context Markdown reader, Frontmatter and index-linked navigation | [#2689](https://github.com/BestNathan/nession/issues/2689) · [#2742](https://github.com/BestNathan/nession/issues/2742) | [Interactive HTML](claude-memory-2689/index.html) · [Scenario & fidelity](claude-memory-2689/README.md) |

| Mobile Terminal Keys / Quick Commands (chords, Insert vs Run) | [#2710](https://github.com/BestNathan/nession/issues/2710) | [Interactive HTML](terminal-keys-commands-2710/index.html) · [Scenario & fidelity](terminal-keys-commands-2710/README.md) |

| Mobile App Swipe / edge navigation & gesture ownership | [#2724](https://github.com/BestNathan/nession/issues/2724) | [Interactive HTML](mobile-swipe-2724/index.html) · [Scenario & fidelity](mobile-swipe-2724/README.md) |

Do not add more `prototypes/<topic>` branches. Add another sibling directory here.

## 2026-11-06 · Whole-gallery presentation refresh

All 14 business prototypes now follow the current [Nession prototype Skill](https://github.com/BestNathan/nession/blob/main/.claude/skills/nession-prototype/SKILL.md) at the **presentation level**. The 12 older directories use `prototype-frame-2758/review-bridge.{css,js}` to preserve their interactive mock logic while exposing a shared overview, fixed CSS-pixel viewport, external scenario controls and separate design/verification details. The already native-framed `terminal-keys-commands-2710` and `session-metadata-2789` remain on the frame kit. `prototype-frame-2758` itself is a presentation demo, not a business capability.

**Status:** GitHub source structure and new review scripts have been checked; no actual Chromium click-through, current production fixture pixel comparison, or new Pages manifest readback is established by this source update. Several legacy product visuals still need a deliberate design-token and App-layout redesign; migrating review chrome is not proof of visual fidelity. No production code or backend effects were changed. All existing direct HTML paths remain stable. Do not claim the public URLs are refreshed until the published manifest SHA agrees with this branch's final commit.

## 2026-11-06 · Cross-prototype responsive and interaction review

**Scope:** static source and interaction-path review of all 14 business prototypes, plus the shared `prototype-frame-2758`. This is **not** a claim of current production visual parity or deployed Pages click-through. Source/VM checks and a 4-case **synthetic** Chromium geometry reproduction (390/960/1440px review widths against 390/1180px devices) were performed separately.

### Confirmed defects repaired at their owners

- **12 historical review-bridge users:** original product `@media` queries were still evaluated against the reviewer browser, even while generated `@container` copies followed the selected device. The bridge now disables the product rule only after its container replacement is prepared; presentation-frame CSS retains its own window breakpoints. It also translates relevant height queries. This prevents a 1180px Web preview from accidentally adopting App CSS when opened in a 390px browser.
- **All framed prototypes:** `np-device` now uses paint containment so legacy `position:fixed` mock dialogs/toasts are anchored to the 1:1 product screen, not the host browser viewport.
- **Files Workspace #2751:** `np:resize` now switches actual Web/App composition; the context menu uses local device coordinates instead of global browser coordinates; the legacy page wrapper fills the selected device; redundant mode proxies and mock-only product footer are removed; obsolete runtime manifest-fetch / source-relink logic is gone.
- **Git/GitHub #1290:** fixture Scenario/Reset/Inspector and snapshot counters now render in the external review harness on **every** update, not just at mount; the product stage and recorded issue reader follow device height. The DOM-stub flow verifies Terminal → Git Workspace → Issues, fixture counter, external inspector and Reset.
- **Claude Memory #2689:** floating contextual surfaces use device-relative widths; edge-swipe ownership uses the embedded App bounding box instead of `window.innerWidth`. The DOM-stub flow verifies App 390 left/right edge swipes even with a 1440px outer browser.
- **AI Conversation #2254:** issue-labeled prototype branding is excluded from the product header.
- **Fixed-column Terminal #2487:** external CDN font did not conform to the trusted Pages font CSP. The simulator now uses deterministic local system-monospace measurement, explicitly labeled as an approximation rather than JetBrains/xterm glyph fidelity.

### Remaining limitations — separate product-fidelity work, not invented bug claims

| Prototype | Remaining review / fidelity work |
|---|---|
| #2514 Agent Process, #2654 Environment | Legacy product chrome and Web/App shell differ from present production patterns; compare against current `FixtureWorkspace` and Agent components before claiming visual fidelity |
| #2221 AI Workspace, #2254 AI Conversation | Reconfirm dynamic Scene / streaming-component choices against latest Vision and current UI tokens; browser state-transition walkthrough remains required |
| #2689 Claude Memory, #2751 Files, #1290 Git | Interaction mock logic has focused fixes, but presentation palette/spacing, real capability navigation and App depth still require current fixture screenshot comparison |
| #2724 Mobile Swipe, #2657 Terminal Direction, #2710 Terminal Keys | Synthetic touch or key interactions are not physical/mobile-browser gesture or actual TUI proof |
| #2664 Knowledge Pages | Source-only mock and typography; published Pages production parity not checked |
| #2598 Terminal Clipboard | Permission/clipboard outcomes are modeled, not proof of real browser Clipboard API / image transfer |
| #2487 Fixed Columns | Local monospace simulation is not the shipped xterm measured-cell renderer; no real font/grid parity is asserted |
| #2789 Session Metadata | Shared frame defect previously fixed; full interactive Chromium and visual comparison still outstanding |

### Regression owners / execution

- Shared: `node --test prototype-frame-2758/frame-geometry.test.mjs prototype-frame-2758/review-bridge.test.mjs prototype-frame-2758/review-migration.test.mjs`.
- Product: `node git-github-1290/smoke-test.mjs`, `node claude-memory-2689/smoke-test.mjs`, plus relevant scenario-specific smoke scripts.
- **Evidence in this review:** actual shared bridge was evaluated with a deterministic JS/CSSOM stub (width and height isolation, accessibility media retention, event dispatch) and actual product scripts were executed in V8 DOM stubs for the edited Git/Files/Memory flows. Synthetic Chromium measured 390 and 1180px product content dimensions and overlay containment at four browser/device combinations. The complete Node suite, all business interactions in Chromium, exact deployed Pages browser screenshots, and production comparison are **not claimed** by these checks.
- Direct HTML links remain under `https://bestnathan.github.io/nession/prototypes/<topic>-<issue>/index.html`. Verify the **final** manifest SHA and trusted deploy receipt before stating the current Pages content equals source HEAD.
