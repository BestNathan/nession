# Claude Code App-first workspace — #3829

> **Historical / partially superseded (2026-11-19):** The conversation-first/Browse IA is retained. The original mock's single-title Header, surface treatment and lack of inner Workspace stack swipe are superseded by [new App Workspace design #3971](../app-workspace-3971/index.html). This older artifact must not be used as current visual or gesture proof until its scenario is synchronized and republished. Original acceptance records are preserved.

Requirement: https://github.com/BestNathan/nession/issues/3829

## Question / fidelity

The current App shares Web's five top-level Claude tabs and a desktop two-column configuration view. The proposal makes the **current conversation the default work**, with one contextual **Browse Claude** sheet for secondary resources and App-appropriate **pushed details**.

- Surface: App Workspace; true-size 375 / 390 / 430 CSS-pixel viewports.
- Product authority: VISION.md, PRINCIPLE.md, docs/design/interaction/app.md, docs/design/capability-emergence.md.
- Source baseline: web/src/capabilities/claude-code/components/ClaudeCodeWorkspace.tsx, WorkspaceShell.tsx, CapabilityCapsule.tsx, shared AIConversation.
- Typography/color approximation: design/tokens/experience/app.json 17/16/14/13px roles and design/tokens/primitive.json neutral light ramp.
- Data: **synthetic fixtures**, no live Claude CLI, Agent, remote filesystem, MCP connection, or external network. No persistent side effects.
- Difference from production: concept-only App resource composition and Browse sheet; production currently uses top-level Claude tabs. Geometry and control styling are informed approximations rather than 1:1 product rendering.

## Scenario contract

1. **Default work** — exact bound/current conversation opens with readable title and messages. Tool activity remains secondary; read-only view never has a fake composer. Nession App host owns exactly one Back/title band.
2. **Terminal continuity** — root Back returns to Terminal; Open Claude workspace restores the same context. Terminal element is kept mounted while the Workspace is shown.
3. **Resource disclosure** — Browse opens a temporary sheet with Work (Conversations / Transcripts) and Resources (Memory / MCP / Configuration). There are no five permanent tabs or extra App sidebar.
4. **Conversation identity** — Browse Conversations → an older conversation → Back. Opening a strict-cwd candidate reads it without falsely binding it to this Session.
5. **Transcript / Raw** — Browse Transcripts → transcript → each known, unknown and malformed record → Raw viewer (JSON tree or original). Malformed JSON remains available as source; no artificial “recognized” badge.
6. **Memory / MCP / Config** — Memory → file; MCP → server → tool schema; Nession setup requires explicit mock confirmation; Configuration → Project/Global → file as a single-column push (no Web split grid).
7. **States** — reviewer-only controls outside product select Bound/Idle, provider-verified Working, Unbound, Agent offline, and Switch Session. Session changes reset source-bound routes, raw inspector, and local scroll cache.
8. **Interaction** — every visible action in the mock has an effect; root/depth Back, scrim dismissal, Escape, reduced-motion and multiple App widths are modeled. The Browse sheet is contextual, not product-global.

## Ownership decisions

- App host: Workspace and Terminal layers, host Back/title, Browse sheet framework, push/depth navigation, safe-area and scroll.
- Claude extension: content and resource identity for conversation, transcripts, memory, MCP, and configuration.
- Shared Nession AIConversation: canonical reader and message view; no new App-only Claude parsing.
- Activity: “Working” / “Idle” only when verified by the capability's provider. Presence of a foreground Claude executable is not evidence of ongoing work.
- The bottom capability capsule is represented as a contextual region, not a new feature bar.
- No Agent selector, no auto-claiming unbound conversations, no new process control or authorization shortcuts.

## Validation / limitations

- Static HTML/JS/CSS and dependency-free simulated data.
- The shared review harness comes from ../prototype-frame-2758/frame.css and frame.js, and is not part of the product mock.
- Browser checks required: 375/390/430px; Browse → each nested route → Back; Raw tree/source; scroll retention; invalid JSON; sheet focus/keyboard/scrim; long titles; disconnected state. Production verification requires Chromium/Playwright and physical/mobile Safari acceptance under #3829.
- Visual IA checks: no duplicated App header, no Web sidebar, no five-tab strip, no configuration split layout, no product prototype notes inside the device.
- This mock does not prove keyboard avoidance, native gesture back, VoiceOver, API pagination, request generation fencing, responsive token fidelity, or real MCP permissions.
- Source is on the shared prototype branch; do not claim Pages is deployed until the published manifest and HTTPS content match an immutable prototype revision.

## Related work

#1120 Claude Peek and Workspace conversations; #3726 transcript records and Raw; #3600 Claude MCP; #2689 memory; #3772 MCP UI kit; #3801 capability-owned Activity.
