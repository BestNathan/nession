# Codex native Workspace prototype (#3789)

- **Requirement:** https://github.com/BestNathan/nession/issues/3789
- **Related Issues:** #3785 native runtime, #3786 Thread/Turn/Item Protocol, #3787 native MCP Tools, #3788 Config/MCP/Skills, #3778 Tool contributions, #3251 AI global resources, #3772 shared MCP UI kit, #1363 AIConversation.
- **Entry:** [index.html](index.html), sibling on shared orphan `prototype` branch.
- **Decision:** Provider-native Domain, Nession-owned Experience. No generic CodingAgent domain; native Thread/Turn/Item and identifiers remain authoritative. AIConversation is a one-way presentation projection only.

## Question and scenario

Can the current Session's Codex capability preserve native Thread, Turn, Item, Approval and Rollout for inspection/control, while exposing Nession's *existing* AIConversation reading experience through a loss-aware adapter rather than an intermediate common back-end domain?

1. Web 1180: select a Thread; click a Turn and select an Item. Native type/ID/status and Raw JSON remain visible in separate inspector. Switch `Conversation`, observe reading-oriented user bubble / work summary / assistant answer. Switch back: native records were not replaced.
2. Click New Thread; required title validation, then a synthetic Thread appears. Select Start Turn, validate required prompt; the new native Turn remains `inProgress`, not fabricated `completed`. Resume idle/existing Thread and Interrupt active Turn work as deterministic mock transitions.
3. Fixture `Approval required`: native approval Item shown, reviewing requires explicit user action; no self-approval. Deny and Approve are simulated and do not actually execute a command.
4. Fixture `Agent offline` and `Unsupported version`: no fabricated idle status, controls disabled; `Empty`: no guessed latest Thread. Session switch clears stale drafts/selection.
5. App 390/375: Thread list → Thread detail → Item inspector; single host-owned header Back returns Item → Thread → list, Capsule remains visible. Switch to Web 1024 and back, verify product composition changes without shrinking selected CSS width.
6. MCP/Skills/Configuration are native Codex-specific resources but project/effective in scope. MCP is a semantic placeholder for #3772 shared kit, **not** a second implementing Tool Inspector or real connection. User/global AI inventory is #3251.

## Surface / ownership / source fidelity

- **Web product ancestry:** WebLayout → Sidebar (agents/sessions) + ShellMain → WorkspacePanel → WorkspaceShell → Codex capability (`Threads` native list/detail/inspector; local resource tabs); one WorkspaceShell CapsuleZone. Existing shell anatomy is approximated with HTML; only Codex-local headers/tabs are added.
- **App ancestry:** AppLayout/AppLayers → WorkspacePanel → exactly one AppPageHeader and Back → WorkspaceShell → Codex local list/detail/inspector with the CapsuleZone from the same shell. No desktop Sidebar in App and no second inner Back.
- **Baseline:** source reviewed 2026-11-17 main `web/src/app/workspace/WorkspaceShell.tsx`, `web/src/app/WorkspacePanel.tsx`, `web/src/app/experiences/{web/WebLayout.tsx,app/AppLayout.tsx}`, `web/src/capabilities/claude-code/components/ClaudeCodeWorkspace.tsx`, `docs/architecture/ai-conversation.md`, `docs/design/design-system/patterns/conversation.md`, `design/generated/web.css`. Visual roles in the product CSS are *snapshot values* of generated `--nession-*` semantics, not new feature-local values; actual rendered production shadcn geometry is **not verified**.
- **Review frame:** `../prototype-frame-2758/frame.css` and `frame.js`, fixed CSS-pixel widths Web 1180/1024, App 390/375; fixture controls outside the product.
- **Explicit candidate delta:** Introduces Codex capability and native inspectors that do not exist in main; preserves existing Workspace/Shell/Capsule owners. The local resource tabs are Codex-only, not global Workspace destinations.

## Test strategy and evidence

- Static: standalone HTML/relative assets and gallery Source anchors, no external CDN, no token/credential/personal data, no real network/process calls, and native vocabulary everywhere other than the explicitly labeled `AIConversation` projection.
- Interaction: 4 viewport size presets, 6 fixture scenarios, New/Resume/Start/Interrupt, native Item/raw, Conversation projection, approval confirmation/denial, Web/App switch, reset, Session-switch staleness, keyboard Escape. All business data is synthetic.
- Required browser checks: Chromium 1180/1024/390/375; viewport content widths (no CSS scale), reviewer browser narrower than Web 1180 with both horizontal stage edges reachable, source/console errors, App Back/focus/touch/scroll; 1180 → 390 → 1180 round-trip without reload.
- **Verification status:** GitHub source commit and backlinks will be pinned after publication; no Chromium click-through or actual product fixture pixel comparison has been executed in this tool path; no Pages manifest exact-SHA verification yet. Do not mark browser/Pages/production Acceptance Pass from this HTML.
- **Limitations:** no Codex App Server, model execution, MCP stdio, authenticated endpoints, persistence, real approvals or backend Session mutation. Simulated TUI/Terminal leave does not attach to real tmux.
