# Project / EROFS / Session creation — interactive prototype

**Owner:** https://github.com/BestNathan/nession/issues/3025

**Linked requirements:** https://github.com/BestNathan/nession/issues/3021 (Project); https://github.com/BestNathan/nession/issues/3022 (Global EROFS); https://github.com/BestNathan/nession/issues/3023 (Agent PVC cache); https://github.com/BestNathan/nession/issues/3024 (Sandbox mount); https://github.com/BestNathan/nession/issues/2681 (Sandbox base).

## Product baseline

Main source inspected 2026-11-08: WebLayout → Sidebar (Agents + flat Sessions) + ShellMain → WorkspacePanel → WorkspaceShell → Project capability. AppLayout/AppLayers: Sessions ← Terminal → Workspace; WorkspacePanel owns the single AppPageHeader and Back, while WorkspaceShell owns the capability capsule. Reference sources: web/src/app/experiences/web/WebLayout.tsx, web/src/app/experiences/app/AppLayout.tsx, web/src/app/experiences/app/AppLayers.tsx, web/src/app/Sidebar.tsx, web/src/app/WorkspacePanel.tsx, web/src/app/workspace/WorkspaceShell.tsx; FixtureShell / FixtureApp; docs/design/product-model.md, workspace.md, interaction/web.md, interaction/app.md; design/generated/web.css.

Candidate delta: Project is a *new contextual Workspace capability*, not a new top-level screen/Sidebar group. Existing and Managed are two Session creation paths, not two Project types. A persistent ProjectEnvironment is not introduced.

## Questions

Can a Project's existing Agent directory and reusable global EROFS artifacts be used from one contextual creation flow without forcing Agent ownership? Can a managed image preparation failure preserve user input and fail closed before Sandbox launch? Can App navigate through the same work with exactly one Back/header at each depth?

## Interactive paths

1. Project Workspace: inspect Git source/ref, existing MacBook location, global Base/Node/Rust/Source EROFS references. Edit Project settings, save, return.
2. Create Existing Session → MacBook path → name → explicit Create → mock Terminal. No image or sandbox.
3. Terminal → Project → Create Managed → select Linux Agent, Source Digest, optional Node/Rust images → prepare images → explicit Create → Terminal.
4. External fixture choices: Agent offline, download failure, unsupported sandbox, warm Agent cache; verify errors, retained draft, retry and no Native fallback.
5. Mock build changes EROFS source artifact to a new immutable digest; existing Session stays on its old version.
6. Switch Web 1180/1024 to App 390/375 and back; test sidebar collapse, Sessions list, App Back and Workspace return.

## UI Spec / ownership

Web sidebar 246px, current-session work frame + Project capability surface, 48px work context line; bottom capability capsule. App: spatial Sessions / Terminal / Workspace, single 55px App page header with Back, 390/375px product content width; no desktop Sidebar or duplicate global header. Scoped local semantic token snapshot based on Nession's generated CSS. This is a high-intent UX study, *not* confirmed pixel-identical to Nession shipped React UI.

## Fidelity and verification

Deterministic, in-browser state only: all Project, Agent, EROFS, Download, Sandbox, Session and settings actions are simulated. No actual GitHub/Server requests, no secrets, no real tmux, no EROFS bytes, no PVC or mount operations. Prior Nession diagnostic Task measurements of 23.90 MiB Project Source, 57.99 MiB Node and 246.47 MiB Rust are displayed as static evidence-backed examples, not runtime results for this mock.

- Static JS syntax was checked at authoring; relative references use local styles.css/app.js and the shared prototype-frame-2758 frame files.
- Real Chromium click-through, keyboard/focus assertions, viewport pixel comparison with actual Fixture, and exact Pages SHA publication are separate checks and are NOT claimed by source-only review.
- This prototype is not production Acceptance evidence.

Direct HTML (only claim current after publisher SHA readback): https://bestnathan.github.io/nession/prototypes/project-session-3025/index.html
Source: https://github.com/BestNathan/nession/tree/prototype/project-session-3025

## Non-goals

No extra EROFS Manager top-level dashboard, automatic scheduler, real session creation, OCI layers, private Github auth, sandbox privileged host test, real browser production parity, or ProjectEnvironment object.
