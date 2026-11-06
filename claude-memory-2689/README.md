# Claude Code Auto Memory — Nession Information Architecture prototype (#2689)

[Issue #2689](https://github.com/BestNathan/nession/issues/2689) · [Interactive HTML](index.html) · [Prototype library](../index.html)


## Reader enhancement — #2742 (2026-11-04)

[Requirement #2742: Rich Claude Code Memory Markdown rendering and index-linked navigation](https://github.com/BestNathan/nession/issues/2742)

This is a **revision of the same Claude Code Memory prototype**, not a new Session, Memory product, or separate mock directory. The existing #2689 contextual Terminal → Context Capsule → Peek → Workspace path remains authoritative.

### Product question / acceptance scenario

Can users browse Claude Code Markdown memory **as readable documents**, while keeping all navigation within the current Session's repository and avoiding a second file-browser shell?

1. From Session Terminal, click **+ → Claude Code → 在 Workspace 查看 Memory**. The Session-derived Repository appears above the Memory document, and **MEMORY.md** is initially selected.
2. Read rendered Markdown: headings, prose, blockquote, inline emphasis/code, lists/checklists and Markdown links. Click **架构约束** in the **Topics** Markdown section, not the left filename list. The reader opens **architecture.md**, shows YAML Frontmatter as restrained metadata and finds **#session-boundary** after the mocked read.
3. Use **‹ 索引** or left **MEMORY.md** to go back; open **interaction.md** and inspect its TOML Frontmatter.
4. Click **恢复记录** (nested relative target \`topics/recovery.md#retry-strategy\`). The first chunk does not yet contain that heading; a truthful notice explains this. Click **继续读取**; the remaining content appears and the deferred fragment scrolls into view. Use its \`../architecture.md#session-boundary\` backlink to navigate safely within the Memory root.
5. Click **不存在的文件** in the index: it remains in the reader and displays a non-destructive missing-file notice. Click the \`../private.md\` escape example: it is blocked. \`javascript:\` and other schemes are also blocked by the isolated mock link policy. The normal Claude Code docs HTTPS link opens an external tab.
6. Use **源码 / 预览** to compare the same file's Markdown source with the rendered document. This toggle is *prototype exploration*, not an approved new persistent product control.
7. In a ~390 px App viewport, the file list and document are push/detail states. The top Back or index button returns to the list/index; the bottom Capability Capsule remains available. Confirm long code/table overflow belongs to the document scroller rather than the whole Workspace.
8. Switch to the **review worktree** (same repository) and **Vol** (another repository); no old document or in-flight fragment should leak into the new Session's Memory. Existing missing, denied and unavailable scenarios remain available.

### Fidelity boundaries

- **Files/Markdown/frontmatter/navigation:** synthetic mock fixtures, parsed by a deliberately **small, dependency-free, safe-subset renderer** in \`app.js\`. This is NOT the production Markdown parser and does not purport to implement full GFM or real YAML/TOML parsing. Production must reuse \`web/src/shared/markdown\`, including its sanitization/frontmatter pipeline.
- **Relative links/fragments:** a deterministic in-memory approximation that only selects files listed in the current fixture; **not** a proof of Agent canonicalized-root security, symlink enforcement, protocol versioning or real Session CWD resolution.
- **Chunk loading:** \`topics/recovery.md\` uses a fixture-only \`<!-- part-2 -->\` separator to simulate incomplete content, continuation and delayed anchor selection. No filesystem read happens.
- **No APIs / mutations / downloads:** no real Claude installation, Session attach, server, websocket, provider configuration, model, private memory contents, or external runtime dependency.
- **Design ownership:** #2689's existing Session-first shell stays in place; #2742 owns only the reader behavior. No global Memory navigation or Repo selector.

### Verification

- Static / syntax: \`node --check claude-memory-2689/app.js\`, \`node claude-memory-2689/smoke-test.mjs\` from the prototype checkout.
- Mock interaction assertions: rich Markdown elements and Frontmatter, index/topic link selection, #fragment, missing and blocked links, partial continuation, Session/repo switch and reset. DOM stub tests cannot prove actual scroll position or visual geometry.
- Real-browser check required independently at desktop and ~390px App: click index → architecture → back → interaction → recovery → load more → back; scroll code/table; inspect focus, console and bottom capsule clearance. **Do not claim browser verification from source checks alone.**
- After commit, confirm that the direct HTML preview and \`prototypes/manifest.json\` contain the new exact pinned prototype SHA. A source push does not prove Pages has deployed.

**Canonical browser route (live revision must be checked separately):** https://bestnathan.github.io/nession/prototypes/claude-memory-2689/index.html

**Source directory:** https://github.com/BestNathan/nession/tree/prototype/claude-memory-2689

---

## Design review — revised after product IA audit (2026-11-03)

The **first mock was incorrect**: it used Terminal and Claude Workspace side-by-side by default, hardcoded a persistent Claude button below Terminal, put an extension-owned shell/header above Workspace, and used the desktop structure as the App shell. This violated the current repository product sources, even though the Session→Repo Memory association was right.

This revision replaces those assumptions with the official current **Standard Session interaction model**:

- [Information Architecture](https://github.com/BestNathan/nession/blob/main/docs/design/information-architecture.md): Session is active work; Terminal dominates; Workspace is contextual depth, not a right panel.
- [Capability Emergence](https://github.com/BestNathan/nession/blob/main/docs/design/capability-emergence.md): dormant → **user-selected Peek** → explicitly opened Workspace, not an always-on Claude surface.
- [TerminalCapsule](https://github.com/BestNathan/nession/blob/main/docs/design/design-system/patterns/terminal-capsule.md) and [ContextCapsule](https://github.com/BestNathan/nession/blob/main/docs/design/design-system/patterns/context-capsule.md): minimal stable composer; `+` opens a contextual capability list in a sibling surface above it; selection opens Peek in the **same** upper slot.
- [SurfaceSwitcher](https://github.com/BestNathan/nession/blob/main/docs/design/design-system/patterns/surface-switcher.md): Web has a **destination circle beside** TerminalCapsule/Workspace capability dock, never a full-height split or a global Terminal/Workspace tab bar.
- [WorkspaceNavigation](https://github.com/BestNathan/nession/blob/main/docs/design/design-system/patterns/workspace-navigation.md): a bounded bottom **Capability Capsule** for Workspace view bindings, present at all depths, no extra shell toolbar above every capability.
- [App Interaction](https://github.com/BestNathan/nession/blob/main/docs/design/interaction/app.md): **Sessions ← Terminal → Workspace** spatial relationship; each App depth owns one Back, the Terminal remains mounted underneath. The App is not a shrunk Web sidebar layout.
- [Web Interaction](https://github.com/BestNathan/nession/blob/main/docs/design/interaction/web.md): collapsed navigation rail with a single Expand action and informational summaries, no mandatory healthy Session header. This mock hides the Web header entirely.

**Not a claim about the separate experimental AI Workspace/System One/Two design (#2221/#2254).** This is the existing standard Nession Session + Claude Code capability path; introducing an AI Workspace Scene here would conflate two deliberately separate product experiences.

## User flow — complete interactive mock

1. Open the HTML: it starts on the **full-width current Session Terminal**. The resting capsule is `[+] Ask Nession… [↑]`; it has **no Claude status ring, tab, or permanent capability button**.
2. Click `+`: Context Capsule appears **above** composer. Choose **Claude Code**. The same upper slot turns into Claude Code **Peek**, saying that Claude is open and summarizing this Session's repository Memory without rendering the full file browser.
3. Select **在 Workspace 查看 Memory**: transition to **Workspace** as the active surface, with the Claude capability selected in the bottom capsule and **Memory already focused**. There is no feature lobby, repository picker, or redundant navigation step.
4. Inside Claude Code, open `MEMORY.md` then choose topic Markdown. The source disclosure is secondary; it reveals how current Session CWD → Git repository → effective Auto Memory was **mocked**.
5. Use the bottom **Terminal** destination to return directly to the same live Terminal. Use the Workspace destination circle for a direct Workspace transition, independent of Peek.
6. Click **☰** (Web: collapsed rail Expand; App: visible Sessions control) to open the flat Session navigator. Choose the **review worktree** Session; it has different CWD but the **same Repo and Memory**. Re-enter Workspace: a previously selected valid topic can persist for that repo.
7. Choose **Vol** from Sessions: another Repo's Memory appears; no previous Nession topic or stale loaded content leaks. Try clean repo (empty), offline Session (unavailable), denied read, and non-Git scratch (no Memory).
8. Test the intent composer: `查看当前 Session 的 Memory` opens a **locally simulated** contextual Memory view; unrelated text reports the limited mock scope, not a fake AI answer.
9. Phone viewport: Terminal is its own full surface. Top control or an edge swipe goes left to Sessions / right to Workspace. In Workspace, a topic opens as a pushed detail; the top Back returns to file list, then Terminal. The bottom **Capability Capsule remains** at every detail depth.

## Source of truth and mock fidelity

| Dimension | Fidelity |
|---|---|
| Session, repo, worktree, Memory, Git branch and CLI presence | Synthetic public-safe fixtures |
| Repo/memory resolution, custom Claude config, non-Git fallback | Explicit fixture mapping only, not actual Git/Claude discovery |
| File listing, indexing, document read and stale reply cancellation | Browser-only deterministic JS simulation |
| Context Capsule, Peek, Web/App navigation and layout | Interactive visual approximation based on current repository design docs |
| Terminal text and continued Session state | Mock Terminal; DOM persists when the Workspace page is shown |
| Real filesystem, Agent, websocket, Claude Code runtime, auth, AI calls, memory mutation | Not implemented, not verified |
| Security / Acceptance / production E2E | Not proved by this mock |

## Verification requirements

Static: `index.html`, `styles.css`, `app.js`, `smoke-test.mjs` and the catalog must exist at the same commit, have no missing assets, broken event targets or external runtime resources. With a checkout run `node --check app.js` then `node claude-memory-2689/smoke-test.mjs` (7 DOM-stub interaction scenarios, including Peek→Workspace, worktree sharing, cross-repo isolation and stale callbacks). This is **not** a real Chromium run.

Browser: click the complete Terminal → `+` → Peek → Workspace → Memory → Terminal loop; check desktop and 375–390 px widths, keyboard Escape and App detail Back, context preservation and Session isolation. Verify JS console, scroll and layering. Source checks alone are **not browser verification**.

Check canonical Pages `prototypes/manifest.json` source SHA and actual HTTPS HTML after publication. A remote commit is **not** proof that Pages has deployed it.

## Decision / non-goals

Memory remains **inside** the Claude Code Workspace capability, as a sibling internal view to conversations/configuration, with a Repository derived from the **current Session**. Do not add a global Memory explorer, repo dropdown, new permanent nav, AI Workspace Scene, write operations or separate Memory service. Internal Claude tab choices and file-row density are prototype decisions, subject to owner visual review, not production API contracts.

Canonical direct HTML (verify live deployment separately): https://bestnathan.github.io/nession/prototypes/claude-memory-2689/index.html

Source: https://github.com/BestNathan/nession/tree/prototype/claude-memory-2689

## Shared review frame — 2026-11-06

- **Entry / preview:** `index.html` is a directly accessible interactive review page using the shared `../prototype-frame-2758/frame.css`, `frame.js` and `review-bridge.*`. Its order is Requirement overview → 1:1 CSS-pixel product mock → interaction/fidelity details. Use the original [Requirement](https://github.com/BestNathan/nession/issues/2689) for the current design contract.
- **Behavior:** preserves this directory's existing state transitions; moves fixture controls, reset, test inspectors, and scenario narratives outside the product viewport wherever they are static. Device width controls and full-page Reset belong to the external harness.
- **Fidelity:** Claude Memory Markdown 与 Frontmatter 使用公开脱敏 fixture。. The original mock's local DOM/CSS is retained; this migration does **not** prove fidelity to React/shadcn, actual xterm, TerminalCapsule, App gesture geometry, or current generated design tokens.
- **Validation:** GitHub source structure and publisher-required source/gallery hooks checked. The new review frame needs an independent Chromium desktop/narrow-viewport walkthrough, keyboard/touch/scroll check, console inspection, and source-vs-fixture visual comparison; **those browser checks are not yet verified**. The public preview is **unverified** until `prototypes/manifest.json` reports the same commit SHA; mock results are never production Acceptance.
- **Publication:** keep the existing direct `https://bestnathan.github.io/nession/prototypes/claude-memory-2689/index.html` URL, but treat the immutable GitHub source commit as authoritative until Pages HTTPS/manifest readback succeeds.

## 2026-11-06 review and fixes

The Memory App's edge-swipe handler previously checked `window.innerWidth` and compared touch positions with the host browser's left/right edges. At an embedded App 390 device inside a desktop browser, swipe navigation was incorrectly disabled. The handler now uses the `#app` bounding rect and device-local touch coordinates. The review bridge also constrains the contextual capsule, Sessions layer and capability widths using device-relative `cqw`, rather than host `100vw`.

The mock smoke test includes a 1440px reviewer / 390px App edge-swipe case. Current source was executed under a V8 DOM stub: left swipe opened Sessions, returning to Terminal worked, right-edge swipe opened Workspace, and returning to Terminal worked (5/5 focused state checks). Physical touch/gesture ownership and production React/App visual consistency remain unverified.

## 2026-11-06 · Current-main Web/App owner tree and capability-local Memory reader

**Corrected source ownership:** current main `4af4bd8de4bc` `WebLayout → Sidebar(Agents/Sessions with controlled collapse) + ShellMain → WorkspaceShell → ClaudeCodeWorkspace → MemoryView`. The old mock used only a 49px permanently collapsed rail and did not expose current Web Session navigation. The real `index.html` now places an expandable 246px Sessions Sidebar as a sibling of the active ShellMain; the 50px rail is only the collapsed **Web** state. It has actual changing sibling width, not just a hidden icon list.

**App:** `AppLayout/AppLayers` owns Sessions, Terminal root and Workspace layer. The single AppPageHeader for the Claude Code Workspace is Shell-owned. **Important main-source correction:** current `MemoryView.tsx` does not register a new WorkspacePanel depth for a selected `MEMORY.md` topic; a file selection remains inside the `ClaudeCodeWorkspace → MemoryView` content tree. Therefore App page title stays **Claude Code** and page Back leaves for Terminal, even when reading `architecture.md`; the Memory file list and Markdown article remain inside the capability with its own *document-level* index link. App renders the bounded file-list region and reader as stacked regions rather than inventing a second global navigation bar or an extra capability.

**Retained reader semantics:** safe repo-scoped relative links, YAML/TOML Frontmatter, code, lists, tables, incomplete chunks, deferred heading scroll, no-memory/offline/denied and worktree/repo identity fixtures. No new Memory repository chooser, top-level tool, or uncontrolled file request.

**Verification:** source `claude-memory-2689/smoke-test.mjs` passed **12/12** real mock state/interaction cases in V8 DOM simulation, including the new Web rail collapse and exact App page-header leave contract, plus previous Markdown navigation and device-local swipe. This is **not** real physical gestures, full Node CLI, production Claude/Agent memory API, or current React/Chromium screenshot parity. `product-ia.css` is scoped to the interactive product and does not modify the reviewer frame.
