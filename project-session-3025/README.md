# Project / EROFS / Session creation — interactive prototype

**Owner:** https://github.com/BestNathan/nession/issues/3025

**Linked requirements:** https://github.com/BestNathan/nession/issues/3021 (Project); https://github.com/BestNathan/nession/issues/3022 (Global EROFS); https://github.com/BestNathan/nession/issues/3023 (Agent PVC cache); https://github.com/BestNathan/nession/issues/3024 (Sandbox mount); https://github.com/BestNathan/nession/issues/2681 (Sandbox base).

## Product baseline

Main source inspected 2026-11-08: WebLayout → Sidebar (Agents + flat Sessions) + ShellMain → WorkspacePanel → WorkspaceShell → Project capability. AppLayout/AppLayers: Sessions ← Terminal → Workspace; WorkspacePanel owns the single AppPageHeader and Back, while WorkspaceShell owns the capability capsule. Reference sources: web/src/app/experiences/web/WebLayout.tsx, web/src/app/experiences/app/AppLayout.tsx, web/src/app/experiences/app/AppLayers.tsx, web/src/app/Sidebar.tsx, web/src/app/WorkspacePanel.tsx, web/src/app/workspace/WorkspaceShell.tsx; FixtureShell / FixtureApp; docs/design/product-model.md, workspace.md, interaction/web.md, interaction/app.md; design/generated/web.css.

**Decision revision:** Project is a first-class navigation entry in Web Sidebar and App Sessions layer, with an independent Project detail destination that works even without a selected Session. The detail may share styling and reusable capability components with Workspace, but it must not depend on WorkspaceShell's Session context. Existing and Managed remain two Session create paths, not Project types. Do not add persistent ProjectEnvironment.

## Questions

Can a Project's existing Agent directory and reusable global EROFS artifacts be used from one contextual creation flow without forcing Agent ownership? Can a managed image preparation failure preserve user input and fail closed before Sandbox launch? Can App navigate through the same work with exactly one Back/header at each depth?

## Interactive paths

1. Web Sidebar → Projects → Nession, or App Sessions → Projects → Nession → independent Project detail. Inspect Git source/ref, MacBook location, shared Base/Node/Rust/Source EROFS references; edit settings and return. Current Session is preserved.
2. Create Existing Session → MacBook path → name → explicit Create → mock Terminal. No image or sandbox.
3. Terminal → Project → Create Managed → select Linux Agent, Source Digest, optional Node/Rust images → prepare images → explicit Create → Terminal.
4. External fixture choices: Agent offline, download failure, unsupported sandbox, warm Agent cache; verify errors, retained draft, retry and no Native fallback.
5. Mock build changes EROFS source artifact to a new immutable digest; existing Session stays on its old version.
6. Switch Web 1180/1024 to App 390/375 and back; verify Project navigation selection, Web rail one Expand plus passive counts, App Sessions → Project detail → Back → Sessions. Use external No Session fixture to test independent Project navigation then create first Session.

## UI Spec / ownership

Web candidate: 246px sidebar hosts Agents, flat Sessions, and a small **Projects** section that remains reachable regardless of Session scroll; clicking a Project renders **ProjectDetail as a distinct main-region destination**. No forced Session-to-Project nesting. Collapse keeps only Expand actionable; Agent/Session/Project counts are passive. App candidate: Sessions spatial layer includes Projects below Session history and above Agents; clicking pushes Project detail with one 55px host-owned AppPageHeader/Back, returning to Sessions. No Project detail is mounted under the Session-scoped WorkspacePanel. Terminal remains separate and mounted by the product shell during navigation. CSS widths 1180/1024 and 390/375. Scoped local semantic token snapshot based on Nession's generated CSS. This is a high-intent UX study, *not* confirmed pixel-identical to Nession shipped React UI.

## Fidelity and verification

Deterministic, in-browser state only: all Project, Agent, EROFS, Download, Sandbox, Session and settings actions are simulated. No actual GitHub/Server requests, no secrets, no real tmux, no EROFS bytes, no PVC or mount operations. Prior Nession diagnostic Task measurements of 23.90 MiB Project Source, 57.99 MiB Node and 246.47 MiB Rust are displayed as static evidence-backed examples, not runtime results for this mock.

- Static JS syntax was checked at authoring; relative references use local styles.css/app.js and the shared prototype-frame-2758 frame files.
- This revision changes navigation semantics, so all earlier screenshots/Chromium results are superseded. Re-run published Pages manifest SHA, real Chromium click-through, keyboard/focus and App/Web responsive tests; production pixel parity still requires separate Fixture comparison.
- This prototype is not production Acceptance evidence.

Direct HTML (only claim current after publisher SHA readback): https://bestnathan.github.io/nession/prototypes/project-session-3025/index.html
Source: https://github.com/BestNathan/nession/tree/prototype/project-session-3025

## Non-goals

No extra EROFS Manager top-level dashboard, automatic scheduler, real session creation, OCI layers, private Github auth, sandbox privileged host test, real browser production parity, or ProjectEnvironment object.
