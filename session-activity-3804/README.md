# Session Activity — Web/App Navigation Prototype (#3804)

**Requirement:** https://github.com/BestNathan/nession/issues/3804  
**Core:** #3800 · **Claude provider:** #3801 / existing native query owner #3779 · **Shell provider:** #3802  
**Delivery:** standalone interactive mock on shared orphan \`prototype\` branch, directory \`session-activity-3804/\`. Do not copy this directory into \`main\` or treat a mock as production behavior.

## Goal and decision

Explore the minimal, consistent Session Activity signal in the **current Session navigation** without confusing it with Agent connectivity, Session lifecycle, client attachment or a Capability-specific Turn/Conversation status.

The unresolved design question: how can a 246px Web Session row and a 375/390px App Session row expose \`working\`, \`idle\`, \`unknown\`, \`attention: input_required\`, and Agent offline **without** adding multiple badges, reflowing rows, creating an independent Session status page, or opening a Capability Peek automatically?

**Candidate answer:** one fixed-width 13px activity glyph beside the Session display title; the second line remains workload · Agent · recency. \`needs input\` and \`Agent unreachable\` earn a brief third line because they change the next action or the reliability of the evidence. Screen readers and native title strings supply an explicit description for all glyphs. No colored dot attempts to merge activity and connectivity.

## Product IA and source baseline (main, inspected 2026-11-17)

This prototype represents a **full Nession Web or App shell**, not a Workspace fixture crop.

- Web: \`WebLayout → Sidebar (flat Sessions, Projects sibling, connectivity footer) + ShellMain → Terminal\`, and \`ShellMain → WorkspacePanel/WorkspaceShell → selected contextual Capability\`. The mock's Workspace is a deliberately shallow content approximation; the Session Activity requirement **does not introduce a new workspace panel**.
- App: \`AppLayout/AppLayers: Sessions ← Terminal → Workspace\`; Sessions list is its own touch-safe spatial layer, never a compact Web Sidebar. Terminal keeps a single header with Sessions and Workspace controls; Workspace has one Back owner. The mock renders active layers in the same fixed product viewport and never remounts a real xterm.
- Session row: \`web/src/product/session/patterns/SessionItem.tsx\`, \`SessionMetaLine\`, \`web/src/product/session/patterns/SessionList.tsx\`, \`web/src/app/Sidebar.tsx\`.
- Core IA: \`docs/design/product-model.md\`, \`docs/design/information-architecture.md\`, \`docs/design/design-system/patterns/session-item.md\`, \`docs/design/interaction/web.md\`, \`docs/design/interaction/app.md\`, \`docs/design/visual-language.md\`.
- CSS snapshot uses \`design/generated/web.css\` at blob \`0bd2219b2541cf85bb3284d47299701a9bce52b5\` for \`--nession-background\`, \`--nession-sidebar\`, \`--nession-foreground\`, \`--nession-muted-foreground\`, \`--nession-border\` etc.; product-specific glyph/icon treatments are **candidates**, not a new generated theme. Do not use mock CSS as production source-of-truth.
- Outer review chrome is from \`prototype-frame-2758/frame.css\` and \`frame.js\`; no product-only mock, viewport selectors, status event injector or reviewer links are inside the product shell.

### Tree / controls and candidate delta

| Product owner → child owner | Visible controls | Delta |
|---|---|---|
| WebLayout → Sidebar → Sessions → SessionItem | select Session, one overflow menu, search | add one activity glyph + possible action-needed line; status does not affect title/recency or selection |
| WebLayout → ShellMain → Terminal | current Session, Workspace, Capsule | unchanged roles; pure text approximate Terminal |
| AppLayers → Sessions → SessionItem | title band, search, select, overflow | same semantics, 44px touch actions; *not* Web rail/sidebar |
| AppLayers → Terminal | Sessions, Workspace, Capsule | unchanged spatial layer path |
| AppLayers → Workspace → AppPageHeader | one Back / title | no competing capability-local leave |
| External review frame → fixture injector | Working/Idle/Input/Unknown/Offline/Re-sync/Stale | **mock-only**; no corresponding real production control |

## Clickable walkthrough

1. Open \`index.html\` (static server or GitHub Pages static publisher). The initial fixture has four synthetic Sessions: Claude \`working\`, Shell \`idle\`, Codex \`working + needs input\` and Shell \`unknown\`.
2. In **Web 1180/1024**, select rows in the Sidebar and verify Terminal title follows selection, the status glyph doesn't change the list row geometry, and one "···" menu offers details/edit/attach/kill without selecting another Session. Collapse and expand the reserved sidebar rail. Search returns matching rows or a clear-search action.
3. Click external event buttons \`Claude · Idle\`, \`Claude · Working\`, \`Needs input\`, \`Unknown\`, \`Agent offline\`, \`Re-sync\`, \`Stale event\`. Inspect the resulting Web/App lists. An offline Agent presents **Unknown** with a connectivity explanation, not a verified Working. Re-sync returns a new verified Working. Stale events are deliberately rejected and do not affect recency.
4. Select **App 390**, then **App 375**. The App opens its Sessions layer. Select Session → Terminal → Sessions; from Terminal go to Workspace and Back. Test the touch-safe row menu, details, edit and exact-name mock kill.
5. Switch back to Web 1180 **without refreshing**. Verify the real composition changes back to Sidebar + ShellMain, not just the review frame width. Reset reloads fixture to the initial state.

### Representative fixture states

| Source observation | Session navigation | Reliability / details |
|---|---|---|
| Claude \`busy\` | Working activity glyph | provider still owns the Pane; process existence alone doesn't prove activity |
| Claude \`idle\` | Quiet hollow glyph | process may still be present |
| Claude \`waiting\` | "!" glyph + "Needs input" line | attention is orthogonal to working |
| unsupported or no observation | "?" glyph | unknown is never encoded as idle |
| Agent offline | "?" + "Agent unreachable" | old observation survives only as historical detail |
| Agent reconnect with current snapshot | verified Working | instance and generation fenced |
| delayed old observation | no visible change | demonstration of stale-rejection intent; **not** real protocol proof |
| multiple providers / Panes | not simulated here | #3800 owns actual aggregation |

## Fidelity / verification / non-goals

| Dimension | Fidelity |
|---|---|
| Session data | Synthetic fixture with fixed Agent names, Session names, recency, Activity values, opaque instance identifiers |
| State machine | Mock local JS; deterministic event transitions, mocked generation/identity rejection, no server push |
| Interaction | Real browser DOM button/input/list navigation, simple focus and modal/menu handling; no real attach, kill, CLI or storage |
| Terminal | Plain-text DOM approximation; not xterm, PTY, ANSI, scrollback, resizing or control-mode proof |
| App | Real CSS-width composition of App Sessions/Terminal/Workspace layers, not real gestures/native keyboard or OS-safe areas |
| Visual | Approximation from Nession generated tokens and current Session row source; **not claimed pixel-identical** until product fixture comparison |
| Side effects | None outside UI; "create/edit/kill" mutate only the local synthetic fixture |
| Public Pages | Source branch commit is not HTTPS deployment evidence; verify \`prototypes/manifest.json\` published SHA and HTML HTTP readback separately |
| Acceptance | No production SC Pass, no GitHub CI evidence, no real Agent/Provider verification |

**Intentionally out of scope:** implementing #3800 aggregation, Codex native status, #3779 official Claude version probe, Shell process/OSC133 integration, production wire contract/schema/codegen, real Web hook/reconciliation, current Shell lifecycle changes, or a status-specific Workspace. Reuse existing UI owners when implementing for production.

## Checks and evidence

- Static: parse \`index.html\`, \`styles.css\`, \`app.js\`; verify relative shared frame references and body frame attribute; verify only synthetic data; avoid external CDNs/secrets.
- Behavioral: desktop/App mode change, row select, status transitions, offline → re-sync, older event rejection, search miss/clear, menu target identity, Escape and exact-name mock kill.
- Browser matrix: Web 1180 and 1024; App 390 and 375; then App → Web reflow at the same review page; reviewer browser narrower than target width must horizontally scroll both edges. Assess typography and touch targets with the actual browser if available.
- **Evidence status:** browser, source SHA and Pages publication verification must be recorded **after** execution. A public HTTPS URL is not considered verified just because the branch was written.

## Reviewer URLs

- Source, branch tip (mutable): https://github.com/BestNathan/nession/tree/prototype/session-activity-3804
- Direct published HTML (requires a verified Pages manifest and HTTPS readback): https://bestnathan.github.io/nession/prototypes/session-activity-3804/index.html
- Immutable source pin: recorded in Issue #3804 when publication commit is finalized.

Avoid writing to any user's real \`~/.nession\`, real Agent or Claude data to test this mock.
