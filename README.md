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

| Server-owned Images: Workspace discovery without a Session, Project explicit reference / Git build bind, Sandbox shared Picker and multi-image composition, Agent cache vs Server Ready; Web/App | [#3181](https://github.com/BestNathan/nession/issues/3181) | [Interactive HTML](images-3181/index.html) · [Scenario & fidelity](images-3181/README.md) |

| AI · Current Session Agent Skills/MCP, no Agent selector; project discovery stays in client extensions | [#3251](https://github.com/BestNathan/nession/issues/3251) | [Interactive HTML](ai-global-resources-3251/index.html) · [Scenario & fidelity](ai-global-resources-3251/README.md) |


| Layout Consistency Lab: shared Experience / semantic layout vs local class drift, Web/App / three surfaces / scroll metrics | [#3194](https://github.com/BestNathan/nession/issues/3194) | [Interactive HTML](layout-consistency-3194/index.html) · [Scenario & fidelity](layout-consistency-3194/README.md) |

| Select / Choice Items: Base UI current vs Nession option visual candidate, Web/App / long-path / keyboard / dark | [#3164](https://github.com/BestNathan/nession/issues/3164) | [Interactive HTML](choice-list-3164/index.html) · [Scenario & fidelity](choice-list-3164/README.md) |

| Unified Overlay & Operation Surfaces (Dialog / Alert / anchored choices / Web-App depth, interaction & visual system) | [#3142](https://github.com/BestNathan/nession/issues/3142) | [Interactive HTML](overlay-system-3142/index.html) · [Scenario & fidelity](overlay-system-3142/README.md) |

| Sandbox strategy tabs: Web sticky left nav + wide scrolling panel / App horizontal tabs + vertical content; five independent policy editors, Overview Enter, Inside effective inspection; revised in place for the shared ResourceDetail / ConfigurationForm / OperationSurface grammar (#3137) | [#3143](https://github.com/BestNathan/nession/issues/3143), [#3141](https://github.com/BestNathan/nession/issues/3141), [#3124](https://github.com/BestNathan/nession/issues/3124) | [Interactive HTML](sandbox-capability-3124/index.html) · [Scenario & fidelity](sandbox-capability-3124/README.md) |


| Web/App Attach and Session operations — responsive Web Dialog, App operation depths; Project Location Select now content-height and wrap-safe; Project operation form now uses named #3137 ConfigurationForm sections (#3089 reopened) | [#3089](https://github.com/BestNathan/nession/issues/3089) | [Interactive HTML](session-operation-surfaces-3089/index.html) · [Scenario & fidelity](session-operation-surfaces-3089/README.md) |

| Project in Sidebar / App Sessions → standalone detail → Existing + Managed Session creation; Project Detail/Create/Settings revised in place for the shared detail/form/operation recipes (#3137) | [#3025](https://github.com/BestNathan/nession/issues/3025), [#3021](https://github.com/BestNathan/nession/issues/3021), [#3022](https://github.com/BestNathan/nession/issues/3022) | [Interactive HTML](project-session-3025/index.html) · [Scenario & fidelity](project-session-3025/README.md) |


| App Sessions · four-action overflow menu, metadata and typed Kill (App spatial layers) | [#2875](https://github.com/BestNathan/nession/issues/2875) | [Interactive HTML](app-session-actions-2875/index.html) · [Scenario & fidelity](app-session-actions-2875/README.md) · [UI Spec](app-session-actions-2875/UI-SPEC.md) |

| Web Sidebar 56px reserved Navigation Rail; Expand/New/Search/Projects; narrow Web/App separation (supersedes #2851 collapsed 0px) | [#3075](https://github.com/BestNathan/nession/issues/3075) | [Interactive HTML](sidebar-navigation-rail-3075/index.html) · [Scenario & fidelity](sidebar-navigation-rail-3075/README.md) |

| Session-first Web Sidebar (historical 0px fully-tucked-away collapse; new rail is #3075) | [#2851](https://github.com/BestNathan/nession/issues/2851) | [Interactive HTML](sidebar-session-first-2851/index.html) · [Scenario & fidelity](sidebar-session-first-2851/README.md) |


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
| #2654 Environment | Legacy product chrome and Web/App shell differ from present production patterns; compare against current `FixtureWorkspace` and Agent components before claiming visual fidelity |
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

## 2026-11-06 · Product visual-fidelity continuation (Files / Git)

Following the cross-gallery defect repair, the next scoped iteration compares mock **product UI** against main `bb48ea565be2` rather than modifying the review frame again. Files #2751 now has a product-local semantic CSS snapshot with 208px navigation, elastic editor and App pushed-detail Back semantics. Git/GitHub #1290 now has a compact GitHeader/local tabs, neutral canvas, flat content and no duplicate global Nession header; its proposed GitHub source tabs remain explicitly candidate behavior. Both use sibling `product-fidelity.css` rather than altering `prototype-frame-2758` or production sources. Product README files identify precise fixture references and deviations.

**Evidence:** targeted V8 DOM mock execution: Files 11/11; Git 16/16 checks; updated checked-in Node test files have **not** been run as the complete Node suite in this tool environment. No complete Chromium visual comparison to current production fixture, no live API, and no trusted Acceptance is claimed. The final prototype commit / Pages SHA must be verified independently.

## 2026-11-06 · Product information-architecture correction (supersedes CSS-only fidelity)

**Important correction:** The previous Files/Git CSS and local layout polish had **not** reproduced the current Nession information-architecture ownership tree. Its wording implying current-product parity is superseded. `1:1` on the preview selector means **actual CSS pixels only**, not product IA or React/component parity.

**Current source baseline:** main `bb48ea565be2`, `WebLayout`, `Sidebar`, `ShellMain`, `WorkspacePanel`, `WorkspaceShell`, `AppPageHeader`, `FilesWebLayout`, `FilesAppLayout`, `GitWorkspace`, and current design semantics. Required full Web tree: `WebLayout → Sidebar(Agents + flat Sessions + collapse/rail) + ShellMain → WorkspacePanel → WorkspaceShell → capability`. Required App tree: `AppLayout/AppLayers → WorkspacePanel → ONE AppPageHeader per depth → WorkspaceShell → capability`, with the Terminal rooted separately and the Capsule owned by the shell.

### Corrected prototypes

| Prototype | Source-mapped IA correction | Evidentiary boundary |
|---|---|---|
| [Files #2751](files-workspace-2751/index.html) | Real WebSidebar sibling of work region; nested WorkspaceShell/Files tree+editor; one App header for Files root, directory, file viewer and search; TerminalCapsule with contextual `+`; Files source selector is local to Files | Two checked-in tests executed under a V8 DOM stub (not native Node/browser) and full navigation state round-trip |
| [Git/GitHub #1290](git-github-1290/index.html) | WebSidebar + WorkspaceShell; Git-local branch/section; App Issue record uses shell page header with one Back; obsolete global mock chrome/capability pages removed | 52/52 deterministic smoke assertions in V8/DOM stub; GitHub source is an unshipped #1290 candidate |
| [WorkContract #2541](work-contract-2541/index.html) | WebSidebar + WorkspaceShell → candidate Work capability; App Contract detail is one header-owned push with no second Work-owned App Back | 10/10 smoke scenarios in V8/DOM stub; Work is a candidate extension, no real provider or API |
| [Session Metadata #2789](session-metadata-2789/index.html) | main WebLayout Sidebar + ShellMain → WorkspaceShell → Session capability; AppLayers/one AppPageHeader; staging PR #2795 SessionDetails → Work context content ordering, rather than the main branch's older body | 40/40 deterministic assertions in V8/DOM stub; no real-browser visual comparison to staging React fixture |
| [Environment #2654](environment-session-2654/index.html) | main WebLayout Sidebar + ShellMain → WorkspaceShell → Environment; Profile/Session navigator is capability-local; one AppPageHeader owns root/pushed profile/binding; Terminal context separate | Two checked-in IA/interaction regression cases evaluated in V8/DOM stub; 15 focused transitions; no browser/production binding verification |
| [Agent Process #2514](agent-process-discovery-2514/index.html) | main WebLayout Sidebar + ShellMain → WorkspaceShell → AgentDetail/AgentProcesses; process Refresh local; no default selected PID; narrow component-inspector Back distinct from AppPageHeader Back | Two checked-in IA/process-scope regression cases evaluated in V8/DOM stub; no Chromium/real Agent process observation |
| [Claude Memory #2689 / #2742](claude-memory-2689/index.html) | main WebLayout controlled Sidebar + ShellMain → WorkspaceShell → ClaudeCodeWorkspace → MemoryView; App's one page-level Back always leaves Workspace, while selection of a file stays inside Memory's list/reader | 12/12 checked-in deterministic mock cases passed in V8 DOM stub; Web collapse, App Back, Markdown/link/frontmatter/scroll retained; no real-browser or provider verification |

**Design candidates (not deployed production IA):** [AI Workspace #2221](ai-workspace-2221/index.html) proposes a separate System One Scene/Action-Space mode; the mock now starts composer-only and **53/53** state/event checks passed in V8. [AI Conversation #2254](ai-conversation-2254/index.html) proposes text-fenced interactive components within a chat; all mock scenario chrome moved outside the product and **17/17** parser assertions plus **2/2** IA/static checks passed in V8. Neither has a current-main equivalent to claim pixel/structure parity. Do not conflate these with main's existing WorkspaceShell and provider-bound `shared/ai-conversation`.

**Other prototypes still IA UNVERIFIED:** #2724 Mobile Swipe, #2664 Knowledge Pages, #2598 Terminal Clipboard, #2657 Terminal Direction, #2487 Fixed Columns and #2710 Terminal Keys. They were previously checked for frame geometry or targeted interactions, not proven current navigation-tree ownership. #2758 is only the shared reviewer frame. Do not declare these defective without a specific reproducer.

**Current review source baseline:** main `4af4bd8de4bc` for `WebLayout/AppLayout`, `WorkspaceShell`, `ClaudeCodeWorkspace` and `MemoryView`. Current vs candidate ownership differs by design; `1:1 CSS px` does not certify either.

**Additional verification commands:** `node claude-memory-2689/smoke-test.mjs`, `node ai-workspace-2221/smoke-test.mjs`, `node ai-conversation-2254/smoke-test.mjs`, `node --test ai-conversation-2254/ia-smoke.test.mjs`. Here these actual checked-in sources were executed in an isolated V8 evaluation, NOT a native Node CLI or browser runtime.

**Remaining requirement:** side-by-side Chromium/Playwright visual and interaction comparison against the canonical `FixtureShell`, `FixtureWorkspace`, `FixtureApp` and current Web/App components at Web 1180/1024, App 390/375, including scroll, focus and nested back. The GitHub Publisher's verified SHA means **publication**, not IA/browser acceptance. No such complete browser comparison is claimed here.

**Current test commands:** `node --test environment-session-2654/ia-smoke.test.mjs agent-process-discovery-2514/ia-smoke.test.mjs`; the actual checked-in scripts were evaluated in a V8 DOM-stub harness here, not executed via a native Node runner. Complete Chromium side-by-side/current production fixture comparison remains open.

**Testing commands recorded for a repository checkout:** `node --test files-workspace-2751/visual-fidelity.test.mjs work-contract-2541/smoke.test.mjs` and `node git-github-1290/smoke-test.mjs`. In the present environment the actual scripts were fetched through the GitHub connector and evaluated with a V8/DOM-stub harness; they were not executed as Node CLI commands.

## 2026-11-09 · Project navigation decision (#3021/#3025)

The Project prototype now tests a **first-class Projects section in Web Sidebar**, plus **Projects in App's Sessions layer**. Clicking opens a standalone Project detail, independent of any selected Session; Existing/Managed creation remains within detail. This supersedes the former Project-only-as-Session-Workspace-capability presentation. A No Session fixture proves that Project can still open and seed a first Session. Backend Project and EROFS ownership are unchanged. Source/publisher/Chromium checks for this revision are tracked on #3025, not inherited from the previous prototype SHA.

## Project maintenance refinement

The Project/EROFS prototype now provides Projects + Create, per-row edit/delete action menu, explicit delete confirmation, optional Project Source and Agent location, and per-Project detail selection. Project deletion does not touch existing Sessions or shared image data. UI is a mock; see #3021/#3025 for API implementation and verification.

## Session Project context (#3082, 2026-11-09)

The shared Project prototype now shows a context-sensed Terminal Project Capsule/Peek derived from the focused Session's explicit project_id, an in-Session Project capability view, and an explicit Associate/Change/Remove form. Sidebar Project remains an independent resource. No Workspace/Project identity conflation or runtime migration.
